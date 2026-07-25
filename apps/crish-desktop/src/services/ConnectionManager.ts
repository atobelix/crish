/**
 * ConnectionManager —— Daemon 连接状态投影器
 *
 * 设计契约（UI projection only；no dual reconnect / probe stack）：
 * - 把 DesktopDaemonClient 的传输层状态投影为 UI 友好的 ConnectionPhase
 * - 通过 client.onState / onMessage 订阅，不独立跑 probe 心跳
 * - probeMissCount / latencyMs 镜像自 client，不独立维护心跳计数
 * - connect() 委托给 client.startKeepAlive()（idempotent），不直接操纵 socket
 * - disconnect() 委托给 client.disconnect()（这是唯一会停止 keepAlive 的路径）
 * - 通过 eventBus 广播连接状态变更
 *
 * 不做的事（治理防线 #5：避免「上帝组件」状态爆炸与重连栈重复）：
 * - 不跑独立 probe 心跳（client 已经有 ping/pong heartbeat + miss tolerance）
 * - 不跑独立重连退避（client 已经有 jittered exponential backoff）
 * - 不在 transport drop 时调 client.disconnect()（会停 keepAlive；client 自管 reconnect）
 *
 * 状态映射：
 *   DaemonConnState            → ConnectionPhase
 *   ─────────────────────────────────────────────
 *   'disconnected'             → 'disconnected'
 *   'connecting'               → 'connecting'
 *   'connected' (未认证)       → 'authenticating'
 *   'connected' (已认证)       → 'ready'
 *   'reconnecting'             → 'recovering'
 *   'failed'                   → 'recovering'   (client 会自动重连)
 */

import {
  DesktopDaemonClient,
  type DaemonConnState,
  getDesktopDaemonClient,
} from '../api/daemonClient';
import { eventBus } from './EventBus';

export type ConnectionPhase =
  | 'disconnected'
  | 'connecting'
  | 'authenticating'
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
  /** 镜像自 client.getHeartbeatMisses()，不独立维护 */
  probeMissCount: number;
  /** 镜像自 client.getReconnectAttempt()，不独立维护 */
  retryAttempt: number;
  /** 当前退避延迟（镜像自 client 内部退避，UI 仅作展示） */
  retryDelay: number;
}

/**
 * metrics 镜像轮询间隔。
 *
 * client 不暴露 onHeartbeat 事件（避免事件风暴），CM 通过周期轮询
 * getHeartbeatMisses / getLastLatencyMs / getReconnectAttempt 同步状态。
 *
 * 500ms 间隔与 client 的 heartbeatMs（默认 8s）解耦：
 * - 不会与心跳 tick 完全对齐，避免假阳性
 * - UI 500ms 内能感知到 miss 变化，体验可接受
 *
 * 收到 pong 消息时（handleClientMessage）会即时同步一次，绕过轮询延迟。
 */
const METRICS_MIRROR_INTERVAL_MS = 500;

/**
 * 等待 client 进入 connected 状态的超时。
 *
 * client 自身的 connect 有 sidecar 重启轮询（最长 ~3s），
 * CM 不重复实现，只是等待 client 完成。
 */
const CLIENT_CONNECT_TIMEOUT_MS = 15_000;

/** 认证超时（与原 AUTH_TIMEOUT_MS 保持一致） */
const AUTH_TIMEOUT_MS = 15_000;

/** 延迟历史窗口大小（用于平滑 latencyMs） */
const LATENCY_HISTORY_SIZE = 5;

/**
 * probe miss 上限：与 client 的 HEARTBEAT_MISS_TOLERANCE 对齐。
 *
 * 用于 computeLevel 把 probeMissCount>=limit 映射为 'offline'。
 * client 自身会在 misses >= tolerance 时 closeSocket 触发重连，
 * CM 不主动触发，只是反映状态。
 */
const PROBE_MISS_LIMIT = 3;

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

  private client: DesktopDaemonClient;
  private state: ConnectionState;
  private callbacks = new Set<(state: ConnectionState) => void>();
  /** metrics 镜像轮询句柄；唯一需要 CM 自管的 timer */
  private metricsTimer: ReturnType<typeof setInterval> | null = null;
  /** 进行中的 connect Promise（用于去重并发 connect 调用） */
  private connectPromise: Promise<void> | null = null;
  /** 延迟平滑窗口 */
  private latencyHistory: number[] = [];
  /** 是否已完成认证（用于把 client 'connected' 投影为 'ready' 还是 'authenticating'） */
  private authenticated = false;
  /** client 事件订阅句柄；dispose 时清理 */
  private unsubState: (() => void) | null = null;
  private unsubMessage: (() => void) | null = null;
  /**
   * heartbeat 事件订阅句柄。
   *
   * client.dispatch 处理 pong 后通过 onHeartbeat 通知 CM，
   * CM 即时同步 probeMissCount / latencyMs，绕过 500ms 轮询延迟。
   */
  private unsubHeartbeat: (() => void) | null = null;

  private constructor(client?: DesktopDaemonClient) {
    this.client = client ?? getDesktopDaemonClient();
    this.state = this.createInitialState();

    // 订阅 client 状态、消息与 heartbeat：CM 是被动投影器，不主动轮询 socket
    this.unsubState = this.client.onState((s, err?) =>
      this.handleClientStateChange(s, err),
    );
    this.unsubMessage = this.client.onMessage((msg) =>
      this.handleClientMessage(msg),
    );
    this.unsubHeartbeat = this.client.onHeartbeat(() => {
      // pong 收到时即时同步 metrics（misses 归零 / latency 更新）
      this.mirrorClientMetrics();
    });
  }

  static getInstance(): ConnectionManager {
    if (!this.instance) {
      this.instance = new ConnectionManager();
    }
    return this.instance;
  }

  // ─── 生命周期 ───────────────────────────────────────────────

  public dispose(): void {
    this.stopMetricsMirror();
    if (this.unsubState) {
      this.unsubState();
      this.unsubState = null;
    }
    if (this.unsubMessage) {
      this.unsubMessage();
      this.unsubMessage = null;
    }
    if (this.unsubHeartbeat) {
      this.unsubHeartbeat();
      this.unsubHeartbeat = null;
    }
    this.callbacks.clear();
  }

  // ─── 连接控制 ───────────────────────────────────────────────

  /**
   * 启动连接流程。
   *
   * 委托给 client.startKeepAlive()（idempotent），不直接操纵 socket。
   * - 已 ready 时立即返回（no-op tear-down）
   * - 进行中则复用现有 connectPromise
   * - 否则启动 keepAlive 并等待 authenticate 完成
   *
   * 失败时不调 client.disconnect()（保持 keepAlive 让 client 自管重连），
   * 只把 phase 切到 'recovering' 并抛错。
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
   * 显式断开：唯一会停止 client keepAlive 的路径。
   *
   * 调用此方法后 client.isKeepAliveStarted() 变为 false。
   * transport drop 时 CM 不会调用此方法（由 handleClientStateChange 投影为 recovering）。
   */
  disconnect(): void {
    this.stopMetricsMirror();
    this.connectPromise = null;
    this.authenticated = false;
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
    // 委托给 client.startKeepAlive()：idempotent，会自管 reconnect。
    // 这是唯一会设 keepAliveStarted=true 的路径，保证测试契约：
    //   "explicit disconnect is the only path that stops client keepAlive"
    this.client.startKeepAlive();
    this.startMetricsMirror();

    // 等待 client 进入 connected 状态。
    // startKeepAlive 内部已 fire-and-forget connect()，这里 await state 即可。
    if (!this.client.isConnected()) {
      await this.waitForClientState(
        'connected',
        CLIENT_CONNECT_TIMEOUT_MS,
      );
    }

    // 进入 authenticating 并等待 'authenticated' 消息。
    // authenticate 内部成功时会调用 enterReadyState() 把 phase 切为 'ready'。
    try {
      await this.authenticate();
    } catch (err) {
      // 认证失败：不调 client.disconnect()，保持 keepAlive 让 client 自管重连。
      // phase 切到 'recovering'，等待 client 自动重连后重新触发 authenticate。
      this.state.phase = 'recovering';
      this.computeLevel();
      this.emitStateChange();
      this.emitEventBus();
      throw err;
    }
  }

  /**
   * 等待 client 进入指定状态（或更后的状态）。
   *
   * 不轮询，纯事件驱动：订阅 client.onState，命中即 resolve。
   * 超时则 reject，让 doConnect 决定后续动作。
   */
  private waitForClientState(
    target: DaemonConnState,
    timeoutMs: number,
  ): Promise<void> {
    if (this.client.getState() === target) return Promise.resolve();
    // 已经超过 target（比如重连中已经是 'reconnecting'）也立即 resolve
    if (this.isClientStateBeyond(target)) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsub();
        reject(
          new Error(
            `Client did not reach state "${target}" within ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      const unsub = this.client.onState((s) => {
        if (s === target || this.isClientStateBeyond(target)) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsub();
          resolve();
        }
      });
    });
  }

  /**
   * 判断 client 状态是否已「超过」target（即不需要再等 target）。
   *
   * 用于 waitForClientState 早退：比如 target='connecting' 但 client 已经 'connected'。
   */
  private isClientStateBeyond(target: DaemonConnState): boolean {
    const s = this.client.getState();
    const order: ReadonlyArray<DaemonConnState> = [
      'disconnected',
      'connecting',
      'connected',
      'reconnecting',
      'failed',
    ];
    const targetIdx = order.indexOf(target);
    const curIdx = order.indexOf(s);
    // 'reconnecting'/'failed' 不算「超过 connecting」——它们是回退状态
    if (target === 'connecting') {
      return s === 'connected';
    }
    return curIdx > targetIdx && curIdx <= order.indexOf('connected');
  }

  /**
   * 发送 authenticate 并等待 'authenticated' / 'auth_error' 消息。
   *
   * 成功时设置 authenticated=true 并调用 enterReadyState()。
   * 失败时抛错（不调 client.disconnect）。
   */
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
          this.authenticated = true;
          this.enterReadyState();
          resolve();
        } else if (type === 'auth_error') {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          unsub();
          reject(
            new Error(String(msg.message ?? 'Authentication failed')),
          );
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
    this.state.retryDelay = 0;
    this.state.lastReadyTimestamp = Date.now();
    this.state.latencyMs = this.client.getLastLatencyMs();
    this.latencyHistory = [];
    this.computeLevel();
    this.emitStateChange();
    this.emitEventBus();
  }

  // ─── 内部：client 事件处理 ──────────────────────────────────

  /**
   * client 状态变更处理器：把 DaemonConnState 投影为 ConnectionPhase。
   *
   * 关键契约：
   * - transport drop（client 进入 'reconnecting'）→ phase='recovering'
   *   不调 client.disconnect()，让 client 自管重连
   * - client 重连成功（'connected'）且 authenticated=false → phase='authenticating'
   *   并主动触发重新认证（因为 client 不会自己发 authenticate）
   * - 首次 connect 流程中（connectPromise != null）→ 不重复触发 authenticate
   */
  private handleClientStateChange(
    s: DaemonConnState,
    _err?: Error,
  ): void {
    const projected = this.projectClientState(s);

    switch (projected) {
      case 'disconnected':
        this.authenticated = false;
        this.state.phase = 'disconnected';
        this.state.probeMissCount = 0;
        break;

      case 'connecting':
        // 只在初始 disconnected → connecting 时切换，避免覆盖 recovering/authenticating
        if (this.state.phase === 'disconnected') {
          this.state.phase = 'connecting';
        }
        break;

      case 'authenticating':
        // client 进入 connected 但 authenticated=false
        // - 首次 connect 流程：connectPromise != null，doConnect 内部会显式 authenticate
        // - 重连后：connectPromise == null，这里主动触发 authenticate
        if (this.state.phase !== 'ready') {
          this.state.phase = 'authenticating';
          if (!this.authenticated && !this.connectPromise) {
            // 重连后重新认证；失败时切回 recovering 等 client 下一次重连
            void this.authenticate().then(
              () => this.enterReadyState(),
              () => {
                if (this.state.phase === 'authenticating') {
                  this.state.phase = 'recovering';
                  this.computeLevel();
                  this.emitStateChange();
                  this.emitEventBus();
                }
              },
            );
          }
        }
        break;

      case 'recovering':
        // transport drop 或 client 重连中：不调 client.disconnect()
        this.state.phase = 'recovering';
        break;

      case 'ready':
        // client connected + authenticated=true：保持 ready
        this.state.phase = 'ready';
        break;
    }

    // 镜像 client 的重连计数
    this.state.retryAttempt = this.client.getReconnectAttempt();
    this.computeLevel();
    this.emitStateChange();
    this.emitEventBus();
  }

  /**
   * 把 client 状态投影为 CM phase。
   *
   * 'connected' 的投影依赖 authenticated 标志：
   * - authenticated=true → 'ready'
   * - authenticated=false → 'authenticating'（首次或重连后待认证）
   */
  private projectClientState(s: DaemonConnState): ConnectionPhase {
    switch (s) {
      case 'disconnected':
        return 'disconnected';
      case 'connecting':
        return 'connecting';
      case 'connected':
        return this.authenticated ? 'ready' : 'authenticating';
      case 'reconnecting':
        return 'recovering';
      case 'failed':
        // client 失败后会自动 scheduleReconnect，UI 上呈现为 recovering
        return 'recovering';
    }
  }

  /**
   * client 消息处理器。
   *
   * 设计说明：
   * - 'pong' 不在此处理：client.dispatch 处理 pong 后通过 onHeartbeat 事件
   *   通知 CM（参见 constructor 中 unsubHeartbeat 注册），实现即时 metrics 同步。
   *   原因是 client.dispatch 处理 pong 后 return，不广播给 onMessage listeners。
   * - 'authenticated' / 'auth_error' 由 authenticate() 内部的临时监听器处理。
   * - 此监听器保留为扩展点：未来若需要处理其他 daemon 消息（如 server push 通知），
   *   可在此添加，无需重新订阅。
   */
  private handleClientMessage(_msg: Record<string, unknown>): void {
    // 当前无业务消息需要 CM 投影；heartbeat 通过 onHeartbeat 处理，
    // authenticate 通过临时监听器处理。
  }

  // ─── 内部：metrics 镜像 ───────────────────────────────────

  /**
   * 启动 metrics 镜像轮询。
   *
   * client 不暴露 onHeartbeat 事件（避免心跳风暴），CM 通过 500ms 轮询
   * getHeartbeatMisses / getLastLatencyMs / getReconnectAttempt 同步状态。
   *
   * 收到 pong 时 handleClientMessage 会即时同步一次，绕过轮询延迟。
   */
  private startMetricsMirror(): void {
    if (this.metricsTimer) return;
    this.metricsTimer = setInterval(() => {
      this.mirrorClientMetrics();
    }, METRICS_MIRROR_INTERVAL_MS);
  }

  private stopMetricsMirror(): void {
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
  }

  /**
   * 从 client 镜像 metrics 到 CM state。
   *
   * 仅在值实际变化时触发 emit，避免无谓的状态广播。
   */
  private mirrorClientMetrics(): void {
    const misses = this.client.getHeartbeatMisses();
    const latency = this.client.getLastLatencyMs();
    const retryAttempt = this.client.getReconnectAttempt();

    let changed = false;
    if (this.state.probeMissCount !== misses) {
      this.state.probeMissCount = misses;
      changed = true;
    }
    if (latency > 0 && latency !== this.state.latencyMs) {
      this.recordLatency(latency);
      changed = true;
    }
    if (this.state.retryAttempt !== retryAttempt) {
      this.state.retryAttempt = retryAttempt;
      changed = true;
    }
    if (changed) {
      this.computeLevel();
      this.emitStateChange();
      this.emitEventBus();
    }
  }

  // ─── 内部：延迟与级别计算 ───────────────────────────────────

  private recordLatency(ms: number): void {
    this.latencyHistory.push(ms);
    if (this.latencyHistory.length > LATENCY_HISTORY_SIZE) {
      this.latencyHistory.shift();
    }
    const avg =
      this.latencyHistory.reduce((a, b) => a + b, 0) /
      this.latencyHistory.length;
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
