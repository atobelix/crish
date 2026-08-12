// ReconnectingWsClient（D4 §6.2 / M5 §4.3）：连接生命周期 + 指数退避
// R2-02 落地范围 = 纯逻辑（心跳定时/假死判定、指数退避参数表、重连相位投影
// 纯函数，对齐 M6 §9.3 对账语义）；connect/disconnect 的 WS 原生接线与
// AppState 联动、游标追平属 R2-03。
//
// 常量真源 = crates/conex-types/src/device/version.rs 协议常量表：
// HEARTBEAT_INTERVAL_MS=30_000（D3 §9.3 移动端 30s 心跳）、
// HEARTBEAT_TIMEOUT_FACTOR=3（3×间隔无消息 → 判定断线，90s 假死）、
// RECONCILE_REBUILD_THRESHOLD=5000（游标落后超阈值 → 快照重建，M6 §9.3 ③）。
import type { WsPhase } from '@/domain/pure/selectors';

export interface ReconnectingWsClientOptions {
  url: string;
  heartbeatMs?: number;
  maxRetryMs?: number;
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

// 骨架：WS 原生接线面（R2-03 实现 connect/disconnect/heartbeat 定时器与相位推进）
export class ReconnectingWsClient {
  constructor(private readonly opts: ReconnectingWsClientOptions) {}

  get url(): string {
    return this.opts.url;
  }

  /** R2-03 实现：建立连接（含版本协商与鉴权首帧，心跳定时器接 shouldSendHeartbeat） */
  connect(): void {
    // 占位
  }

  /** R2-03 实现：主动断开（iOS 后台挂起等场景） */
  disconnect(): void {
    // 占位
  }

  /** R2-03 实现：内部相位读取（供 mapWsPhase 投影；假死判定接 isHeartbeatDead） */
  get phase(): WsPhase {
    return 'idle';
  }
}
