/**
 * Desktop engine WebSocket client (product-integrated).
 *
 * Guarantees for packaged / Tauri product:
 * - Engine is part of the app; URL is shell-managed, not a user concept.
 * - Keep-alive never permanently gives up; sidecar restarts on failure.
 * - Frontend never blocks paint; readiness is reported via state listeners.
 */

import { isProductShell, isTauriShell } from './productMode';
import { invokeResult, tryInvokeTauri } from './tauriInvoke';

export type DaemonConnState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed';

type Pending = {
  requestId: string;
  expected: string | string[];
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type EventCb = (msg: Record<string, unknown>) => void;

const DEFAULT_TIMEOUT = 30_000;
/** 长任务期间更勤保活，避免中途掉线 */
const HEARTBEAT_MS = 8_000;
/**
 * 心跳容错：3 次 = 24s 半死窗口（旧值 6 = 48s 太长）。
 * 真实断连后用户需等近一分钟才重连，体验不可接受。
 * 3 次足以容忍单次网络抖动 / 心跳请求被长任务短暂阻塞。
 */
export const HEARTBEAT_MISS_TOLERANCE = 3;
const RECONNECT_BASE_MS = 350;
/** In product shell, restart sidecar more aggressively. */
const SIDECAR_RESTART_EVERY_PRODUCT = 2;
const SIDECAR_RESTART_EVERY_DEV = 4;

function rid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function matchesType(type: string, expected: string | string[]) {
  return typeof expected === 'string' ? type === expected : expected.includes(type);
}

async function fetchShellEndpoint(): Promise<{ url: string | null; available: boolean }> {
  const ep = await tryInvokeTauri<{
    available?: boolean;
    url?: string | null;
    port?: number | null;
  }>('workbench_daemon_endpoint');
  if (!ep) return { url: null, available: false };
  if (ep.available && ep.url) return { url: ep.url, available: true };
  if (ep.port) return { url: `ws://127.0.0.1:${ep.port}`, available: true };
  return { url: null, available: Boolean(ep.available) };
}

/**
 * Resolve engine URL.
 * Product/Tauri: shell endpoint only (never user localStorage override).
 * Browser dev: env / localStorage / default 8765.
 */
async function resolveWsUrl(): Promise<string> {
  const product = isProductShell() || isTauriShell();

  if (product) {
    const shell = await fetchShellEndpoint();
    if (shell.url) return shell.url;
    // Endpoint not published yet — still dial default while sidecar boots
    return 'ws://127.0.0.1:8765';
  }

  const env = import.meta.env as { VITE_DAEMON_WS_URL?: string; VITE_DAEMON_PORT?: string };
  const fromEnv = env.VITE_DAEMON_WS_URL;
  if (fromEnv) return fromEnv;

  try {
    const stored = localStorage.getItem('crish_daemon_ws');
    if (stored) return stored;
  } catch {
    /* ignore */
  }

  const shell = await fetchShellEndpoint();
  if (shell.url) return shell.url;

  const port = env.VITE_DAEMON_PORT || '8765';
  return `ws://127.0.0.1:${port}`;
}

export interface DesktopDaemonClientOptions {
  /** Override heartbeat interval in ms (for tests). Defaults to HEARTBEAT_MS. */
  heartbeatMs?: number;
  /** Override heartbeat miss tolerance (for tests). Defaults to HEARTBEAT_MISS_TOLERANCE. */
  heartbeatMissTolerance?: number;
  /** Override WebSocket constructor (for tests). */
  webSocketFactory?: (url: string) => WebSocket;
}

export class DesktopDaemonClient {
  private socket: WebSocket | null = null;
  private state: DaemonConnState = 'disconnected';
  private pending = new Map<string, Pending>();
  private listeners = new Set<EventCb>();
  private stateListeners = new Set<(s: DaemonConnState, err?: Error) => void>();
  private url: string | null = null;
  private explicitClose = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private keepAliveStarted = false;
  private connectPromise: Promise<void> | null = null;
  private lastError: Error | null = null;
  private suppressCloseReconnect = false;
  /** First successful engine connection in this process. */
  private everConnected = false;
  private heartbeatMisses = 0;
  private pendingPingId: string | null = null;
  private lastLatencyMs = 0;
  private pendingPingSentAt = 0;
  private readonly heartbeatMs: number;
  private readonly heartbeatMissTolerance: number;
  private readonly webSocketFactory: (url: string) => WebSocket;

  constructor(opts: DesktopDaemonClientOptions = {}) {
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
    this.heartbeatMissTolerance = opts.heartbeatMissTolerance ?? HEARTBEAT_MISS_TOLERANCE;
    this.webSocketFactory = opts.webSocketFactory ?? ((url) => new WebSocket(url));
  }

  getState() {
    return this.state;
  }

  getUrl() {
    return this.url;
  }

  getLastError() {
    return this.lastError;
  }

  hasEverConnected() {
    return this.everConnected;
  }

  /** 产品策略：已启动 keep-alive 则对 UI 视为「引擎在场」（可重连，不恐吓离线） */
  isKeepAliveStarted() {
    return this.keepAliveStarted;
  }

  /** Latest ping→pong RTT in ms (0 if none measured yet). */
  getLastLatencyMs(): number {
    return this.lastLatencyMs;
  }

  /** Consecutive heartbeat misses (outstanding ping with no pong). */
  getHeartbeatMisses(): number {
    return this.heartbeatMisses;
  }

  /** The requestId of the currently outstanding ping, or null if none. */
  getPendingPingId(): string | null {
    return this.pendingPingId;
  }

  /** Number of reconnect attempts since last successful connection. */
  getReconnectAttempt(): number {
    return this.reconnectAttempt;
  }

  isConnected() {
    return this.state === 'connected' && !!this.socket && this.socket.readyState === WebSocket.OPEN;
  }

  onState(cb: (s: DaemonConnState, err?: Error) => void) {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  onMessage(cb: EventCb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Start background keep-alive (idempotent). Call once at app boot.
   */
  startKeepAlive(): void {
    if (this.keepAliveStarted) return;
    this.keepAliveStarted = true;
    this.explicitClose = false;
    void this.connect().catch(() => {
      /* scheduleReconnect handles persistence */
    });
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    if (this.connectPromise) return this.connectPromise;

    this.explicitClose = false;
    this.connectPromise = this.attemptConnect()
      .catch((e) => {
        const err = e instanceof Error ? e : new Error(String(e));
        console.warn('[DesktopDaemonClient] connect failed:', err.message);
        this.lastError = err;
        this.handleFailure(err);
        throw err;
      })
      .finally(() => {
        this.connectPromise = null;
      });

    return this.connectPromise;
  }

  async waitUntilConnected(timeoutMs = 15_000): Promise<boolean> {
    if (this.isConnected()) return true;
    this.startKeepAlive();
    if (!this.isConnected()) {
      void this.connect().catch(() => undefined);
    }
    if (this.isConnected()) return true;

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        unsub();
        resolve(this.isConnected());
      }, timeoutMs);

      const unsub = this.onState((s) => {
        if (s === 'connected' && this.isConnected()) {
          clearTimeout(timer);
          unsub();
          resolve(true);
        }
      });
    });
  }

  disconnect() {
    this.explicitClose = true;
    this.keepAliveStarted = false;
    this.clearReconnect();
    this.stopHeartbeat();
    this.closeSocket();
    this.failPending('disconnected');
    this.setState('disconnected');
  }

  async request<T = unknown>(
    command: Record<string, unknown>,
    expectedType: string | string[],
    timeoutMs = DEFAULT_TIMEOUT,
  ): Promise<T> {
    if (!this.isConnected()) {
      const ok = await this.waitUntilConnected(Math.min(timeoutMs, 12_000));
      if (!ok || !this.socket) {
        throw new Error(`Daemon not connected (${this.state})`);
      }
    }
    const requestId = rid('req');
    const payload = { ...command, requestId };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Daemon request timeout: ${String(command.type)}`));
      }, timeoutMs);

      this.pending.set(requestId, {
        requestId,
        expected: expectedType,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      try {
        this.socket!.send(JSON.stringify(payload));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  async send(command: Record<string, unknown>): Promise<void> {
    if (!this.isConnected()) {
      const ok = await this.waitUntilConnected(12_000);
      if (!ok || !this.socket) {
        throw new Error(`Daemon not connected (${this.state})`);
      }
    }
    const requestId = rid('cmd');
    this.socket!.send(JSON.stringify({ ...command, requestId }));
  }

  // ── internal ──────────────────────────────────────────────

  private sidecarRestartEvery() {
    return isProductShell() || isTauriShell()
      ? SIDECAR_RESTART_EVERY_PRODUCT
      : SIDECAR_RESTART_EVERY_DEV;
  }

  private async attemptConnect(): Promise<void> {
    this.setState(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting');

    // 冷启动 race 修复：
    // - 首次连接（attempt=0）：先检查 sidecar endpoint 是否已就绪。
    //   已就绪 → 跳过 restart，直接 openSocket（避免与 Tauri 冷启动 race）。
    //   未就绪 → 调用 tryRestartSidecar 启动它（否则永远连不上）。
    // - 重连（attempt>0）：按取模命中 restart（保持原逻辑）。
    // 旧实现无条件在 attempt=0 时 restart，会与 Tauri 端正在启动的 sidecar race；
    // 但完全跳过首次 restart 会导致 sidecar 未运行时永远连不上。
    const every = this.sidecarRestartEvery();
    const needRestart =
      this.reconnectAttempt === 0 || this.reconnectAttempt % every === 0;
    if (needRestart) {
      if (this.reconnectAttempt === 0) {
        // 首次连接：先探测 sidecar 是否已就绪
        const shell = await fetchShellEndpoint();
        if (shell.available && shell.url) {
          this.url = shell.url;
        } else {
          await this.tryRestartSidecar();
        }
      } else {
        await this.tryRestartSidecar();
      }
    }

    this.url = await resolveWsUrl();
    await this.openSocket(this.url);
    this.reconnectAttempt = 0;
    this.lastError = null;
    this.everConnected = true;
    this.setState('connected');
    this.startHeartbeat();
  }

  private async tryRestartSidecar(): Promise<void> {
    if (!isTauriShell() && !isProductShell()) {
      const ep = await tryInvokeTauri<{ available?: boolean }>('workbench_daemon_endpoint');
      if (!ep) {
        this.lastError = new Error('Daemon sidecar unavailable in browser dev mode');
        return;
      }
    }
    const result = await invokeResult('workbench_restart_daemon');
    if (result.status !== 'ok') {
      const msg = result.status === 'error' ? result.message : 'restart command missing';
      this.lastError = new Error(`Sidecar restart failed: ${msg}`);
      if (isTauriShell() || isProductShell()) {
        console.warn('[DesktopDaemonClient]', this.lastError.message);
      }
      return;
    }
    // 轮询等待 sidecar 就绪：15 × 200ms = 3s（Windows 冷启动通常 1-2s）
    for (let i = 0; i < 15; i++) {
      const shell = await fetchShellEndpoint();
      if (shell.available && shell.url) {
        this.url = shell.url;
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    this.lastError = new Error('Sidecar restart timed out after 3s polling');
    console.warn('[DesktopDaemonClient]', this.lastError.message);
  }

  private openSocket(url: string): Promise<void> {
    this.suppressCloseReconnect = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = this.webSocketFactory(url);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }

      const cleanupOpenHandlers = () => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
      };

      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanupOpenHandlers();
        this.socket = ws;
        ws.addEventListener('close', onClose);
        ws.addEventListener('message', onMessage);
        ws.addEventListener('error', onRuntimeError);
        resolve();
      };

      const onError = () => {
        if (settled) return;
        settled = true;
        cleanupOpenHandlers();
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`Failed to connect engine at ${url}`));
      };

      const onClose = () => {
        if (this.socket === ws) this.socket = null;
        this.stopHeartbeat();
        this.failPending('connection closed');
        if (this.suppressCloseReconnect) {
          this.suppressCloseReconnect = false;
          return;
        }
        if (!this.explicitClose) {
          this.scheduleReconnect();
        } else {
          this.setState('disconnected');
        }
      };

      const onRuntimeError = () => {
        /* close handler drives reconnect */
      };

      const onMessage = (ev: MessageEvent) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        this.dispatch(msg);
      };

      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
    });
  }

  private dispatch(msg: Record<string, unknown>) {
    const type = String(msg.type ?? '');
    const requestId =
      typeof msg.requestId === 'string'
        ? msg.requestId
        : typeof msg.correlationId === 'string'
          ? msg.correlationId
          : null;

    // Handle pong: correlated (matching requestId) or simple uncorrelated {type:'pong'}
    if (type === 'pong') {
      const isCorrelated = requestId && requestId === this.pendingPingId;
      const isUncorrelated = !requestId && this.pendingPingId !== null;
      if (isCorrelated || isUncorrelated) {
        if (this.pendingPingSentAt > 0) {
          this.lastLatencyMs = Date.now() - this.pendingPingSentAt;
        }
        this.pendingPingId = null;
        this.pendingPingSentAt = 0;
        this.heartbeatMisses = 0;
        return;
      }
    }

    if (requestId && this.pending.has(requestId)) {
      const p = this.pending.get(requestId)!;
      if (type === 'error' || matchesType(type, p.expected)) {
        clearTimeout(p.timer);
        this.pending.delete(requestId);
        if (type === 'error') {
          p.reject(new Error(String(msg.message ?? msg.error ?? 'Daemon error')));
        } else {
          p.resolve(msg);
        }
        return;
      }
    }

    for (const cb of this.listeners) {
      try {
        cb(msg);
      } catch (e) {
        console.error('[DesktopDaemonClient] listener error', e);
      }
    }
  }

  private scheduleReconnect() {
    if (this.explicitClose) return;
    if (this.reconnectTimer) return;

    this.reconnectAttempt += 1;
    
    // 渐进式指数退避 + 随机抖动 (Jittered Exponential Backoff)
    // 初始快速尝试，随着重试次数增加，最大间隔拉大到 5 分钟，防止长任务断线大面积惊群效应
    const exponent = Math.min(this.reconnectAttempt - 1, 12);
    const baseDelay = Math.min(
      300_000, // 5 分钟上限
      RECONNECT_BASE_MS * Math.pow(1.8, exponent)
    );
    const jitter = Math.random() * 1000;
    const delay = baseDelay + jitter;

    this.setState('reconnecting', this.lastError ?? undefined);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => {
        /* next schedule from handleFailure / close */
      });
    }, delay);
  }

  private handleFailure(err: Error) {
    this.lastError = err;
    this.stopHeartbeat();
    this.closeSocket();
    if (this.explicitClose) {
      this.setState('failed', err);
      return;
    }
    this.scheduleReconnect();
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatMisses = 0;
    this.pendingPingId = null;
    this.pendingPingSentAt = 0;
    let lastHeartbeatTime = Date.now();

    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const elapsed = now - lastHeartbeatTime;
      lastHeartbeatTime = now;

      // 自动识别系统休眠唤醒 / Event Loop 严重挂起状态 (时间差大于预期 2.5 倍)
      if (elapsed > this.heartbeatMs * 2.5) {
        console.warn(`[DesktopDaemonClient] 心跳间隔异常大 (${elapsed}ms)，判定为系统休眠恢复或主线程严重阻塞，重置心跳未命中计数。`);
        this.heartbeatMisses = 0;
        this.pendingPingId = null;
      }

      if (this.socket?.readyState === WebSocket.OPEN) {
        // If there was a pending ping from the previous tick that was not answered → miss
        if (this.pendingPingId !== null) {
          this.heartbeatMisses += 1;
          if (this.heartbeatMisses >= this.heartbeatMissTolerance) {
            this.lastError = new Error('Engine heartbeat failed');
            this.pendingPingId = null;
            this.closeSocket();
            if (!this.explicitClose) this.scheduleReconnect();
            return;
          }
        }
        // Send new ping with a unique requestId
        const pingId = rid('ping');
        this.pendingPingId = pingId;
        this.pendingPingSentAt = Date.now();
        try {
          this.socket.send(JSON.stringify({ type: 'ping', requestId: pingId }));
        } catch {
          /* socket may have closed between readyState check and send */
        }
      } else {
        this.heartbeatMisses += 1;
        if (this.heartbeatMisses >= this.heartbeatMissTolerance) {
          this.lastError = new Error('Engine heartbeat failed');
          this.closeSocket();
          if (!this.explicitClose) this.scheduleReconnect();
        }
      }
    }, this.heartbeatMs);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeSocket() {
    if (this.socket) {
      this.suppressCloseReconnect = true;
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
  }

  private failPending(reason: string) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private setState(state: DaemonConnState, err?: Error) {
    this.state = state;
    for (const cb of this.stateListeners) {
      try {
        cb(state, err);
      } catch {
        /* ignore */
      }
    }
  }
}

let singleton: DesktopDaemonClient | null = null;

export function getDesktopDaemonClient(): DesktopDaemonClient {
  if (!singleton) singleton = new DesktopDaemonClient();
  return singleton;
}

/** Boot hook: start keep-alive without blocking render. */
export function bootstrapDesktopBackend(): DesktopDaemonClient {
  const client = getDesktopDaemonClient();
  client.startKeepAlive();
  return client;
}

/**
 * Reset singleton for unit tests. Call in beforeEach/afterEach.
 * @testonly
 */
export function resetDesktopDaemonClientForTests(): void {
  if (singleton) {
    try { singleton.disconnect(); } catch { /* ignore */ }
  }
  singleton = null;
}
