// ReconnectingWsClient（D4 §6.2 / M5 §4.3）：连接生命周期 + 指数退避
// R2-02 落地范围 = 纯逻辑（心跳定时/假死判定、指数退避参数表）+ connect/disconnect
// 原生 WebSocket 接线：
// - 连接状态机（M5 §4.3.1）：idle → connecting → open ⇄ reconnecting（退避），
//   连续失败超 maxRetries（默认 5 次）或断网（offline 注入）→ dead 终态
//   （任务书相位列「closed」= 本实现的 dead；idle = 主动断开后回到起点，
//   等待 connect() 再触发）；
// - 心跳（D3 §9.3）：open 后每 30s 发 heartbeat，3×间隔（90s）无收包 → 判定
//   假死主动 close → 走重连；heartbeat.ok 重置假死计时 + 时钟校准留点；
// - 握手看门狗：8s 未 open 主动放弃（CONNECT_TIMEOUT_MS），杜绝永久 connecting；
// - 退避清零延后：open 后持续 5s 未断才清零计数（CONNECTION_STABLE_MS），
//   弱网抖动下重连延迟严格指数递增；
// - 重连后的会话对账 / 离线补发：单一链路 = events.subscribe → events.subscribe.ok
//   （FeedBridge.onOpen 订阅、approvalWiring.onSyncReady 重放），本类不再持有
//   第二套投影机制（原 ReconnectProjection 死代码已删除，实现波总方案 C2）；
// - 断开清理：意外断开 → 挂起请求 reject（transport.closed）；主动 disconnect
//   → reject（cmd.cancelled）+ 清心跳/重连计时器，**不自动重连**（R2B §4）；
// - 消息路由：onmessage → decodeFrame → WsGateway 分发（订阅路由骨架见
//   setupRoutes，业务语义 R2-05 域实现）。
// AppState 联动（前台探活）见 appRuntime.handleAppState；NetInfo 不引入。
//
// 常量真源 = crates/conex-types/src/device/version.rs 协议常量表：
// HEARTBEAT_INTERVAL_MS=30_000（D3 §9.3 移动端 30s 心跳）、
// HEARTBEAT_TIMEOUT_FACTOR=3（3×间隔无消息 → 判定断线，90s 假死）、
import { WsGateway, GatewayError, decodeFrame } from './WsGateway';
import { buildAuthenticatedWsUrl } from './EndpointResolver';

/** WS 内部相位（D4 §6.2.2 / 本类状态机词汇表：类型所有权归 network——
 *  上层（domain 投影 / wiring）依赖本类型为正确单向；此前定义在
 *  domain/pure/selectors 造成 network → domain 反向引用，R4 批次6 归位） */
export type WsPhase = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'dead';

/** 注入的 WebSocket 最小接口（RN 内建 WebSocket 子集；mock 用同一形状） */
export interface WsSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

/** WebSocket 工厂（测试注入 mock；RN 默认全局 new WebSocket(url)）。
 *  token/握手帧由构造参数注入（见 ReconnectingWsClientOptions.token，R2-03 接线点），
 *  不在工厂签名上展开（RN WebSocket 不支持自定义 header）。 */
export type WebSocketFactory = (url: string) => WsSocket;

export interface ReconnectingWsClientOptions {
  url: string;
  /** 心跳间隔覆盖（缺省 30s；假死阈值按 3×间隔缩放） */
  heartbeatMs?: number;
  /** 退避封顶覆盖（缺省 RETRY_BACKOFF_CAP_MS = 30s） */
  maxRetryMs?: number;
  /** 连续重连失败上限（M5 §4.3.1 默认 5；超限 → dead 终态） */
  maxRetries?: number;
  /** 退避抖动上限（缺省 1s；测试传 0 锁定退避序列） */
  jitterMaxMs?: number;
  /** WebSocket 工厂（RN 默认全局；测试注入 mock class） */
  factory?: WebSocketFactory;
  /** 消息分发出口（缺省内部新建；测试可注入 spy 网关） */
  gateway?: WsGateway;
  /** 会话令牌（R2-03 配对派生后替换注入源：secure-store 读取；当前为接线占位） */
  token?: string;
  /** 相位变化回调（R2-03 接线点：连接 store 投影 mapWsPhase 消费） */
  onPhaseChange?: (phase: WsPhase) => void;
  /** 断网判定（R2-03 接线点：NetInfo；true = 断网 → 直接 dead 不重试） */
  offline?: () => boolean;
  /** 时钟注入（缺省 Date.now；测试用 fake timers 或固定注入） */
  now?: () => number;
}

// ── 心跳定时（D3 §9.3 / version.rs 协议常量表）───────────────────────────

/** 应用心跳间隔（移动端每 30s 发 heartbeat，D3 §9.3） */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** 断线判定倍数（3 × 心跳间隔无消息 → 判定断线） */
export const HEARTBEAT_TIMEOUT_FACTOR = 3;
/** 假死判定窗口 = 30s × 3 = 90s（任务书口径：90s 判定假死） */
export const HEARTBEAT_DEAD_MS =
  HEARTBEAT_INTERVAL_MS * HEARTBEAT_TIMEOUT_FACTOR;

/** 假死判定：距上次收包超过 3×心跳间隔（90s）→ 连接已死，应发起重连 */
export function isHeartbeatDead(
  lastRxMs: number,
  nowMs: number,
  factor = HEARTBEAT_TIMEOUT_FACTOR
): boolean {
  return nowMs - lastRxMs >= HEARTBEAT_INTERVAL_MS * factor;
}

/** 心跳节拍判定：距上次发包达到心跳间隔 → 应发 heartbeat 帧 */
export function shouldSendHeartbeat(
  lastTxMs: number,
  nowMs: number,
  intervalMs = HEARTBEAT_INTERVAL_MS
): boolean {
  return nowMs - lastTxMs >= intervalMs;
}

// ── 指数退避参数表（D4 §6.2.4：1s → 2s → 4s → 8s → 16s → 30s 封顶）─────────

export interface BackoffParams {
  /** 初值（失败第 1 次的延迟），默认 1s */
  baseMs?: number;
  /** 倍率，默认 2 */
  multiplier?: number;
  /** 封顶，默认 30s */
  capMs?: number;
  /** 附加随机抖动上限（0~jitterMaxMs），默认 1s；传 0 关闭抖动便于测试 */
  jitterMaxMs?: number;
}

/**
 * 指数退避 + 抖动：`min(base × multiplier^retry, cap) + 随机[0, jitterMax)`
 * 骨架兼容：`nextRetryDelayMs(retryCount)` 默认参数 = D4 §6.2.4 参数表。
 */
export function nextRetryDelayMs(
  retryCount: number,
  opts: BackoffParams = {}
): number {
  const base = opts.baseMs ?? RETRY_BACKOFF_BASE_MS;
  const multiplier = opts.multiplier ?? RETRY_BACKOFF_MULTIPLIER;
  const cap = opts.capMs ?? RETRY_BACKOFF_CAP_MS;
  const jitterMax = opts.jitterMaxMs ?? RETRY_JITTER_MAX_MS;
  const delay = Math.min(
    base * multiplier ** Math.max(0, Math.floor(retryCount)),
    cap
  );
  return delay + Math.floor(Math.random() * jitterMax);
}

export const RETRY_BACKOFF_BASE_MS = 1_000;
export const RETRY_BACKOFF_MULTIPLIER = 2;
export const RETRY_BACKOFF_CAP_MS = 30_000;
export const RETRY_JITTER_MAX_MS = 1_000;

// ── 连接健壮性常量 ─────────────────────────────────────────────────────────

/** 单次握手看门狗：8s 未 open 视为握手挂起，主动 close 进入退避重连
 *  （不依赖操作系统 TCP 超时，杜绝弱网下永久停留在 connecting） */
export const CONNECT_TIMEOUT_MS = 8_000;
/** 连接稳定判定窗口：open 后持续 5s 未断才清零退避计数
 *  （弱网「刚连上就断」不 reset，重连延迟严格按指数递增，防抖动风暴） */
export const CONNECTION_STABLE_MS = 5_000;

// ── WS 原生接线（M5 §4.3.1 连接状态机）─────────────────────────────────────

/** RN 全局 WebSocket 默认工厂（jest 环境无原生 WS，测试注入 mock 工厂） */
function defaultFactory(url: string): WsSocket {
  return new WebSocket(url) as unknown as WsSocket;
}

export class ReconnectingWsClient {
  /** 当前 socket（null = 无活跃连接） */
  private ws: WsSocket | null = null;
  private phaseValue: WsPhase = 'idle';
  private retryCountValue = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** 握手看门狗（openSocket 启动，open/close 清除） */
  private connectWatchdog: ReturnType<typeof setTimeout> | null = null;
  /** 连接稳定计时器（open 后 CONNECTION_STABLE_MS 未断 → 清零退避计数） */
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  /** 上次收包时刻（任何消息都算收包，D3 §9.3「3×间隔无消息 → 断线」） */
  private lastRxMsValue = 0;
  /** 上次发包时刻（心跳节拍判定 shouldSendHeartbeat） */
  private lastTxMs = 0;
  private lastHeartbeatOkValue: { ts: number; serverTime: number } | null =
    null;
  /** 主动断开标记（disconnect 触发；关闭事件据此不进入重连） */
  private manualClose = false;
  private readonly heartbeatInterval: number;
  private readonly maxRetries: number;

  /** 消息分发出口（R2-05 域订阅 / 测试断言；构造注入或内部新建） */
  readonly gateway: WsGateway;

  constructor(private readonly opts: ReconnectingWsClientOptions) {
    this.gateway = opts.gateway ?? new WsGateway({ msgIdPrefix: 'mob' });
    this.heartbeatInterval = opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
    this.maxRetries = opts.maxRetries ?? 5;
    this.setupRoutes();
  }

  get url(): string {
    return this.opts.url;
  }

  /** 内部相位读取（供 mapWsPhase 投影；dead = 任务书「closed」终态，D4 §6.2.5） */
  get phase(): WsPhase {
    return this.phaseValue;
  }

  /** 上次收包时刻（前台唤醒探活：active 且距上次收包过久 → 直接重建连接） */
  get lastRxMs(): number {
    return this.lastRxMsValue;
  }

  /** 会话令牌（R2-03 接线点：配对派生后由 secure-store 提供，构造注入） */
  get token(): string | undefined {
    return this.opts.token;
  }

  /** 动态更新认证 token（避免重构连接实例） */
  setAuth(params: { token?: string }): void {
    if (params.token !== undefined) this.opts.token = params.token;
  }

  /** 连续失败次数（诊断 / 单测断言） */
  get retryCount(): number {
    return this.retryCountValue;
  }

  /** 最近一次 heartbeat.ok 回执（时钟校准输入：serverTime - 本地接收时刻，R2-03） */
  get lastHeartbeatOk(): { ts: number; serverTime: number } | null {
    return this.lastHeartbeatOkValue;
  }

  /** 发送首帧事件订阅（D3 §9.3 / 协议契约 events.subscribe） */
  sendSubscribe(
    sessions: string[] = [],
    lastSequences: Record<string, number> = {},
    ackMode: 'auto' | 'manual' = 'auto'
  ): void {
    this.gateway.send('events.subscribe', {
      sessions: sessions.slice(0, 32),
      lastSequences,
      ackMode,
    });
  }

  /** 建立连接（idle/dead → connecting → open）。已连接/连接中 → noop（防双连接，
   *  R2B §4 补充建议）；重连退避等待中调用 → 取消退避立即重试。 */
  connect(): void {
    if (this.phaseValue === 'connecting' || this.phaseValue === 'open') return;
    this.cancelReconnectTimer();
    this.retryCountValue = 0;
    this.manualClose = false;
    // 残留 socket（onerror 后未 close 的边缘态）先关掉，防双连接泄漏
    if (this.ws) {
      const stale = this.ws;
      this.ws = null;
      this.detachSocketHandlers(stale);
      stale.close();
    }
    this.setPhase('connecting');
    this.openSocket();
  }

  /** 主动断开（iOS 后台挂起等场景，M5 §4.3.2）：清 pending/心跳/重连计时器，
   *  相位回 idle；**不自动重连**（等待 connect() 再触发）。幂等（已 idle 无操作）。 */
  disconnect(): void {
    this.cancelReconnectTimer();
    this.cancelConnectWatchdog();
    if (this.stableTimer !== null) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    this.stopHeartbeat();
    this.manualClose = true;
    this.retryCountValue = 0;
    this.gateway.abortAllPending(
      new GatewayError('cmd.cancelled', '连接已主动断开', false)
    );
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      this.detachSocketHandlers(ws);
      ws.close();
    }
    this.setPhase('idle');
  }

  private openSocket(): void {
    const factory = this.opts.factory ?? defaultFactory;
    const connectUrl = buildAuthenticatedWsUrl(this.opts.url, {
      token: this.opts.token,
    });
    const ws = factory(connectUrl);
    this.ws = ws;
    // 握手看门狗：8s 未 open 主动放弃本次握手（close → onclose → 退避重连）
    this.connectWatchdog = setTimeout(() => {
      this.connectWatchdog = null;
      if (this.ws === ws && this.phaseValue !== 'open') {
        console.warn('[ReconnectingWsClient] 握手超时，放弃本次连接');
        ws.close();
      }
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => this.handleOpen(ws);
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onclose = () => this.handleClose();
    ws.onerror = () => this.handleError();
  }

  private handleOpen(ws: WsSocket): void {
    this.cancelConnectWatchdog();
    this.cancelReconnectTimer();
    // 出站接线：优先完成出站管道绑定，保证任何下游回调发起出站帧时 sendFn 已可用
    this.gateway.attachSend((raw) => {
      if (this.ws === ws) ws.send(raw);
    });
    this.setPhase('open');
    this.startHeartbeat();
    this.markRx();
    // 退避清零延后至连接稳定（CONNECTION_STABLE_MS 未断）：
    // 弱网「刚 open 就被 RST」不 reset，重连延迟严格指数递增，防抖动风暴
    if (this.stableTimer !== null) clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      if (this.phaseValue === 'open') this.retryCountValue = 0;
    }, CONNECTION_STABLE_MS);
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return; // 协议 v1 全文本帧；非文本形态宽容丢弃
    this.markRx(); // 收到任何消息 → 重置假死计时（D3 §9.3）
    const result = decodeFrame(data);
    if (!result.ok) {
      // 解码失败：宽容丢弃 + 记日志（D3 §10.3，不打断连接）
      console.warn(
        `[ReconnectingWsClient] 解码失败丢弃（${result.error.code}）：${result.error.message}`
      );
      return;
    }
    this.gateway.dispatchFrame(result.frame);
  }

  private handleClose(): void {
    this.cancelConnectWatchdog();
    if (this.stableTimer !== null) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    this.stopHeartbeat();
    this.ws = null;
    if (this.manualClose) return; // 主动断开：不进入重连
    // 意外断开：挂起请求立即失败（transport.closed，retryable → outbox 层重发）
    this.gateway.abortAllPending(
      new GatewayError('transport.closed', '连接被对端关闭', true)
    );
    this.scheduleReconnect();
  }

  /** onerror 只记日志不推进相位（M5 R-02：以 onclose 为判死事件，不依赖 onerror 时序） */
  private handleError(): void {
    console.warn(
      '[ReconnectingWsClient] WebSocket error（等待 close 事件判死）'
    );
  }

  /** 指数退避重连（M5 §4.3.2）：1s→2s→4s→8s→16s→30s 封顶 + 抖动；
   *  连续失败超 maxRetries 或断网 → dead 终态（D4 §6.2.5 offline 语义） */
  private scheduleReconnect(): void {
    this.retryCountValue += 1;
    if (this.opts.offline?.() || this.retryCountValue > this.maxRetries) {
      this.setPhase('dead');
      return;
    }
    this.setPhase('reconnecting');
    const delay = nextRetryDelayMs(this.retryCountValue - 1, {
      capMs: this.opts.maxRetryMs,
      jitterMaxMs: this.opts.jitterMaxMs,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.setPhase('connecting');
      this.openSocket();
    }, delay);
  }

  private cancelReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private cancelConnectWatchdog(): void {
    if (this.connectWatchdog !== null) {
      clearTimeout(this.connectWatchdog);
      this.connectWatchdog = null;
    }
  }

  // ── 心跳（D3 §9.3：30s 心跳 / 3×间隔 90s 假死）───────────────────────────

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(
      () => this.heartbeatTick(),
      this.heartbeatInterval
    );
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private heartbeatTick(): void {
    if (this.phaseValue !== 'open') return;
    const now = this.now();
    if (shouldSendHeartbeat(this.lastTxMs, now, this.heartbeatInterval)) {
      this.gateway.send('heartbeat', { ts: now, deviceTimeMs: now });
      this.lastTxMs = now;
    }
    // 假死判定（3×间隔无收包）→ 主动关闭 → onclose → 重连（D3 §9.3）
    const factor =
      HEARTBEAT_TIMEOUT_FACTOR *
      (this.heartbeatInterval / HEARTBEAT_INTERVAL_MS);
    if (isHeartbeatDead(this.lastRxMsValue, now, factor)) {
      this.ws?.close();
    }
  }

  private markRx(): void {
    this.lastRxMsValue = this.now();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private setPhase(next: WsPhase): void {
    if (this.phaseValue === next) return;
    this.phaseValue = next;
    this.opts.onPhaseChange?.(next);
  }

  private detachSocketHandlers(ws: WsSocket): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
  }

  /** 消息路由骨架（心跳回执；业务事件路由由上层接线如 FeedBridge 接入） */
  private setupRoutes(): void {
    this.gateway.on('heartbeat.ok', (env) => {
      // 完整实现（R2-02）：收到 heartbeat.ok → 重置假死计时 + 时钟校准留点
      this.markRx();
      const body = env.body as Record<string, unknown>;
      if (
        typeof body['ts'] === 'number' &&
        typeof body['serverTime'] === 'number'
      ) {
        this.lastHeartbeatOkValue = {
          ts: body['ts'],
          serverTime: body['serverTime'],
        };
        // R2-03：serverTime - 本地接收时刻 → clockOffset（clock.ts 校准）
      }
    });
  }
}
