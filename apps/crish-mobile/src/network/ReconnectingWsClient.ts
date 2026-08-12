// ReconnectingWsClient（D4 §6.2 / M5 §4.3）：连接生命周期 + 指数退避
// R2-02 落地范围 = 纯逻辑（心跳定时/假死判定、指数退避参数表、重连相位投影
// 纯函数，对齐 M6 §9.3 对账语义）+ connect/disconnect 原生 WebSocket 接线：
// - 连接状态机（M5 §4.3.1）：idle → connecting → open ⇄ reconnecting（退避），
//   连续失败超 maxRetries（默认 5 次）或断网（offline 注入）→ dead 终态
//   （任务书相位列「closed」= 本实现的 dead；idle = 主动断开后回到起点，
//   等待 connect() 再触发）；
// - 心跳（D3 §9.3）：open 后每 30s 发 heartbeat，3×间隔（90s）无收包 → 判定
//   假死主动 close → 走重连；heartbeat.ok 重置假死计时 + 时钟校准留点；
// - 重连退避：复用 nextRetryDelayMs 参数表（1s→2s→4s→8s→16s→30s 封顶，+抖动）；
// - 断开清理：意外断开 → 挂起请求 reject（transport.closed）；主动 disconnect
//   → reject（cmd.cancelled）+ 清心跳/重连计时器，**不自动重连**（R2B §4）；
// - 消息路由：onmessage → decodeFrame → WsGateway 分发（订阅路由骨架见
//   setupRoutes，业务语义 R2-05 域实现）。
// AppState 联动、NetInfo 即时重连、游标追平属 R2-03/05（接线点已留接口）。
//
// 常量真源 = crates/conex-types/src/device/version.rs 协议常量表：
// HEARTBEAT_INTERVAL_MS=30_000（D3 §9.3 移动端 30s 心跳）、
// HEARTBEAT_TIMEOUT_FACTOR=3（3×间隔无消息 → 判定断线，90s 假死）、
// RECONCILE_REBUILD_THRESHOLD=5000（游标落后超阈值 → 快照重建，M6 §9.3 ③）。
import type { WsPhase } from '@/domain/pure/selectors';
import { WsGateway, GatewayError, decodeFrame } from './WsGateway';

/** 注入的 WebSocket 最小接口（RN 内建 WebSocket 子集；mock 用同一形状） */
export interface WsSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

/**
 * WebSocket 工厂（测试注入 mock；RN 环境默认 new WebSocket(url)）。
 * token/握手帧由构造参数注入（见 ReconnectingWsClientOptions.token，R2-03 接线点），
 * 不在工厂签名上展开（RN WebSocket 不支持自定义 header）。
 */
export type WebSocketFactory = (url: string) => WsSocket;

/** 重连对账输入源（R2-05 接线点：本地投影快照 + outbox 状态） */
export interface ReconnectProjectionSource {
  snapshots: ReconcileSnapshot[];
  outboxPending: boolean;
}

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
  /** 对账输入源（R2-05 接线点：本地投影快照/outbox；缺省空输入） */
  projections?: () => ReconnectProjectionSource;
  /** 相位变化回调（R2-03 接线点：连接 store 投影 mapWsPhase 消费） */
  onPhaseChange?: (phase: WsPhase) => void;
  /** 重连投影回调（M6 §9.3：open 相位对账结果；R2-05 接线点） */
  onProjection?: (projection: ReconnectProjection) => void;
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

// ── 重连相位投影（M6 §9.3 重连后的对账）──────────────────────────────────

/** 游标落后重建阈值（事件数；落后超阈值 → 快照重建而非增量补齐） */
export const RECONCILE_REBUILD_THRESHOLD = 5000;

/**
 * 对账快照（subscribe.ok 逐会话结果 + 本地投影游标）
 * - localCursor：本地持久化游标；undefined = 本地无该会话投影；
 * - serverNext：subscribe.ok.nextSequence（服务端当前 max）；
 *   -1 表示服务端权威无此会话（会话已删除，M6 §9.3 ②）；
 * - serverStale：subscribe.ok.stale（本地游标超服务端 max，D3 §7.5 窗口语义）。
 */
export interface ReconcileSnapshot {
  sessionId: string;
  localCursor?: number;
  serverNext: number;
  serverStale: boolean;
}

/** 对账动作（M6 §9.3 ①订阅对账 ②投影对账 ③游标对账 的分类结果） */
export type ReconcileAction =
  'fresh' | 'resume' | 'full-replay' | 'cleanup' | 'noop';

/**
 * 单会话对账分类（M6 §9.3 语义）：
 * - 本地无投影 → fresh（② 权威有本地无 → 写入投影 + 初始化游标）；
 * - 服务端无此会话（serverNext = -1）→ cleanup（② 本地有权威无 → 清理
 *   本地投影 + 游标 + 队列）；
 * - stale 或落后超重建阈值 → full-replay（① stale=true 全量回放 /
 *   ③ 落后超 5000 → 快照重建）；
 * - 落后未超阈值 → resume（① stale=false 增量补齐 afterSequence 分页）；
 * - 游标一致 → noop。
 */
export function classifyReconcile(
  snap: ReconcileSnapshot,
  rebuildThreshold = RECONCILE_REBUILD_THRESHOLD
): ReconcileAction {
  if (snap.localCursor === undefined) return 'fresh';
  if (snap.serverNext < 0) return 'cleanup';
  if (snap.serverStale) return 'full-replay';
  if (snap.serverNext - snap.localCursor > rebuildThreshold)
    return 'full-replay';
  if (snap.serverNext > snap.localCursor) return 'resume';
  return 'noop';
}

/** 重连投影结果（M6 §9.3 ①~⑤；log = ⑤ 分歧留痕，不静默） */
export interface ReconnectProjection {
  phase: WsPhase;
  /** 逐会话动作（按输入顺序） */
  actions: ReconcileAction[];
  /** 需 events.resume 增量补齐的会话 */
  resume: string[];
  /** 需全量回放/快照重建的会话 */
  fullReplay: string[];
  /** 需清理本地投影 + 游标 + 队列的会话（②） */
  cleanup: string[];
  /** 需写入投影并初始化游标的会话（②） */
  fresh: string[];
  /** ④ 队列对账：outbox 有待提交命令 → 需逐条重发（msgId 不变幂等，M6 §9.2） */
  outboxFlush: boolean;
  /** ⑤ 留痕：全部分歧写本地日志 */
  log: string[];
}

/**
 * 重连相位投影纯函数：仅在 open 相位（重连成功 → subscribe.ok 后）执行对账，
 * 其他相位不产生动作（对账入口 = auth.refresh → events.subscribe，M6 §9.3）。
 */
export function projectReconnect(
  phase: WsPhase,
  snapshots: ReconcileSnapshot[],
  outboxPending: boolean,
  rebuildThreshold = RECONCILE_REBUILD_THRESHOLD
): ReconnectProjection {
  const empty: ReconnectProjection = {
    phase,
    actions: [],
    resume: [],
    fullReplay: [],
    cleanup: [],
    fresh: [],
    outboxFlush: false,
    log: [],
  };
  if (phase !== 'open') return empty;

  const actions: ReconcileAction[] = [];
  const resume: string[] = [];
  const fullReplay: string[] = [];
  const cleanup: string[] = [];
  const fresh: string[] = [];
  const log: string[] = [];

  for (const snap of snapshots) {
    const action = classifyReconcile(snap, rebuildThreshold);
    actions.push(action);
    switch (action) {
      case 'resume':
        resume.push(snap.sessionId);
        log.push(
          `游标对账：${snap.sessionId} 落后 ${snap.serverNext - (snap.localCursor ?? 0)}，走 resume 增量补齐`
        );
        break;
      case 'full-replay':
        fullReplay.push(snap.sessionId);
        log.push(
          `游标对账：${snap.sessionId} 需全量回放（stale 或落后超重建阈值）`
        );
        break;
      case 'cleanup':
        cleanup.push(snap.sessionId);
        log.push(
          `投影对账：${snap.sessionId} 服务端已无此会话，清理本地投影 + 游标 + 队列`
        );
        break;
      case 'fresh':
        fresh.push(snap.sessionId);
        log.push(
          `投影对账：${snap.sessionId} 本地无投影，写入投影并初始化游标`
        );
        break;
      case 'noop':
        break;
    }
  }

  const outboxFlush = outboxPending;
  if (outboxFlush)
    log.push('队列对账：outbox 有待提交命令，逐条重发（msgId 不变，幂等）');
  return {
    phase,
    actions,
    resume,
    fullReplay,
    cleanup,
    fresh,
    outboxFlush,
    log,
  };
}

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
  /** 上次收包时刻（任何消息都算收包，D3 §9.3「3×间隔无消息 → 断线」） */
  private lastRxMs = 0;
  /** 上次发包时刻（心跳节拍判定 shouldSendHeartbeat） */
  private lastTxMs = 0;
  private lastHeartbeatOkValue: { ts: number; serverTime: number } | null =
    null;
  private lastProjectionValue: ReconnectProjection | null = null;
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

  /** 会话令牌（R2-03 接线点：配对派生后由 secure-store 提供，构造注入） */
  get token(): string | undefined {
    return this.opts.token;
  }

  /** 连续失败次数（诊断 / 单测断言） */
  get retryCount(): number {
    return this.retryCountValue;
  }

  /** 最近一次重连投影（M6 §9.3：open 相位对账结果；null = 尚未 open 过） */
  get lastProjection(): ReconnectProjection | null {
    return this.lastProjectionValue;
  }

  /** 最近一次 heartbeat.ok 回执（时钟校准输入：serverTime - 本地接收时刻，R2-03） */
  get lastHeartbeatOk(): { ts: number; serverTime: number } | null {
    return this.lastHeartbeatOkValue;
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
    const ws = factory(this.opts.url);
    this.ws = ws;
    ws.onopen = () => this.handleOpen(ws);
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onclose = () => this.handleClose();
    ws.onerror = () => this.handleError();
  }

  private handleOpen(ws: WsSocket): void {
    this.cancelReconnectTimer();
    this.retryCountValue = 0;
    this.setPhase('open');
    // 出站接线：发送闭包绑定当前 socket；socket 换代后旧闭包自动失效（防错发）
    this.gateway.attachSend((raw) => {
      if (this.ws === ws) ws.send(raw);
    });
    this.startHeartbeat();
    this.markRx();
    this.driveProjection();
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
    if (isHeartbeatDead(this.lastRxMs, now, factor)) {
      this.ws?.close();
    }
  }

  private markRx(): void {
    this.lastRxMs = this.now();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private setPhase(next: WsPhase): void {
    if (this.phaseValue === next) return;
    this.phaseValue = next;
    this.opts.onPhaseChange?.(next);
  }

  /** 重连相位投影（M6 §9.3）：open 相位驱动对账；结果经 onProjection 上抛。
   *  对账输入源（快照/outbox）为 R2-05 接线点，缺省空输入。 */
  private driveProjection(): void {
    const source = this.opts.projections?.() ?? {
      snapshots: [],
      outboxPending: false,
    };
    const projection = projectReconnect(
      'open',
      source.snapshots,
      source.outboxPending
    );
    this.lastProjectionValue = projection;
    this.opts.onProjection?.(projection);
  }

  private detachSocketHandlers(ws: WsSocket): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
  }

  /** 消息路由骨架（R2-02：只接分发，业务语义 R2-05 域实现） */
  private setupRoutes(): void {
    this.gateway.on('events.subscribe.ok', () => {
      // R2-05：① 订阅对账——逐会话 nextSequence/stale 驱动 resume/full-replay 分类
    });
    this.gateway.on('events.resume.page', () => {
      // R2-05：续传分页应用（EventPage 契约；游标推进，(sessionId, sequence) 去重）
    });
    this.gateway.on('events.resume.done', () => {
      // R2-05：续传完成（resumedTo 水位；桌面恢复实时推流）
    });
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
