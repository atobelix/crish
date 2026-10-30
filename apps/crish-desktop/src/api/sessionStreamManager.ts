/**
 * 按会话隔离的流式 run 注册表（进程级唯一实例 `sessionStreams`）。
 *
 * - 句柄：每轮 run 一个，持有 L2/L3 取消入口与该 run 独占的 StreamRenderBuffer；
 * - starter：按 sessionId 登记（分栏各自挂载的 ChatCard 互不覆盖），续写 / drain 经
 *   `scheduleStart` 在 onComplete 栈结束后启动。优先该会话自己的 starter；会话视图未挂载
 *   （后台 run 收口）时由最近登记的 starter 代为启动（starter 以 sessionId 显式定址）；
 *   当前无任何 starter 时挂起，待下次登记时启动；
 * - goal-cancel / drain 标记与串行守卫（S7）退避计数。
 */

import type { StreamRenderBuffer } from './StreamRenderBuffer';
import type { StreamCancelMode } from './runControlClient';
import { logger, toErrMeta } from '../services/LoggerService';
import { isSessionTombstoned } from '../utils/lifecycle/ScopedLifecycleRegistry';

export type { StreamCancelMode } from './runControlClient';

export interface SessionStreamHandle {
  /** 本轮用户消息 id */
  readonly userMsgId: string;
  /** 本轮 assistant 占位 id；每轮唯一，作为句柄身份（release 守卫键） */
  readonly assistantMsgId: string;
  /** 本轮独占的渲染缓冲：随句柄创建，随句柄取消而重置 */
  readonly renderBuffer: StreamRenderBuffer;
  /** 后端 runId：onRunMeta 到达后写入（L1 follow-up / L2/L3 wire 使用） */
  runId: string | null;
  /** L2 cooperative / L3 force；调用方必须显式给出模式 */
  cancel(mode: StreamCancelMode): void;
}

/** 续写启动器：按 sessionId 显式定址启动一轮 run */
export type StreamStarter = (
  sessionId: string,
  modelText: string,
  userMsgId: string
) => void;

/** 续写调度器（默认 microtask；串行守卫退避时为 setTimeout） */
export type StartScheduler = (fn: () => void) => void;

/**
 * 串行守卫（S7 / SESSION_BUSY）自动排队的退避重试计数（FINAL-PLAN P1-d 方案 B）。
 *
 * - 运行时、不持久化：userMsgId → { sessionId, attempt }；
 * - streamSession 的 S7 分支 noteBusy（第 n 次被拒）；run 被后端受理 / 用尽 /
 *   会话清理时 clearBusy；
 * - drain（goalContinuation.drainQueuedAfterComplete）按 attempt 计算退避：
 *   300 → 600 → 1200 → 2400ms，最多 BUSY_RETRY_MAX_ATTEMPTS 次；用尽后
 *   消息 queued → error 并经 reportRuntimeStatus 交给 ComposerErrorBar。
 * - 无计数的普通 drain（用户主动排队的追问）保持 microtask，不受影响。
 */
export const BUSY_RETRY_MAX_ATTEMPTS = 4;
export const BUSY_RETRY_BASE_DELAY_MS = 300;

type BusyRetryEntry = { sessionId: string; attempt: number };
const busyRetry = new Map<string, BusyRetryEntry>();

/** 记一次串行守卫拒绝；返回累计次数（从 1 起） */
export function noteBusy(sessionId: string, userMsgId: string): number {
  const prev = busyRetry.get(userMsgId);
  const attempt = (prev?.attempt ?? 0) + 1;
  busyRetry.set(userMsgId, { sessionId, attempt });
  return attempt;
}

export function clearBusy(userMsgId: string): void {
  busyRetry.delete(userMsgId);
}

/** 当前累计拒绝次数（无记录 = 0） */
export function getBusyAttempt(userMsgId: string): number {
  return busyRetry.get(userMsgId)?.attempt ?? 0;
}

/** 该消息是否处于串行守卫自动排队重试中（气泡 Tooltip 附 S7 详情用） */
export function isBusyRetryPending(userMsgId: string): boolean {
  return busyRetry.has(userMsgId);
}

/** 第 attempt 次拒绝后的退避时长：300 * 2^(attempt-1) */
export function busyRetryDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return BUSY_RETRY_BASE_DELAY_MS * 2 ** (n - 1);
}

function clearBusyForSession(sessionId: string): void {
  for (const [id, entry] of busyRetry) {
    if (entry.sessionId === sessionId) busyRetry.delete(id);
  }
}

/** 测试复位 */
export function resetBusyRetryForTests(): void {
  busyRetry.clear();
}

const MODULE = 'SessionStreamRegistry';

type PendingStart = { modelText: string; userMsgId: string };

const microtask: StartScheduler = (fn) => queueMicrotask(fn);

function cancelHandle(
  sessionId: string,
  handle: SessionStreamHandle,
  mode: StreamCancelMode
): void {
  try {
    handle.cancel(mode);
  } catch (err) {
    logger.warn(`[SessionStreamRegistry] stream cancel (${mode}) threw`, {
      module: MODULE,
      sessionId,
      runId: handle.runId ?? undefined,
      err: toErrMeta(err),
    });
  }
  handle.renderBuffer.reset();
}

class SessionStreamRegistry {
  private readonly streams = new Map<string, SessionStreamHandle>();
  /** sessionId → 登记栈（同会话多视图时后登记者生效，解绑只移除自己） */
  private readonly starters = new Map<string, StreamStarter[]>();
  /** 无任何已登记 starter 时挂起的续写（下次 bindStarter 时启动） */
  private readonly pendingStarts = new Map<string, PendingStart>();
  private readonly draining = new Set<string>();
  /** 用户停止后禁止该会话 goal 自动续写（一次性消费） */
  private readonly goalCancelled = new Set<string>();
  /** Store 存活探测（由 bootstrapStores 注入，避免 api 反向依赖 store） */
  private sessionAliveOracle: ((sessionId: string) => boolean) | null = null;

  /** 登记本轮句柄；同会话已有句柄时先以 force 取消旧句柄（防幽灵 run） */
  register(
    sessionId: string,
    handle: SessionStreamHandle
  ): SessionStreamHandle | undefined {
    const prev = this.streams.get(sessionId);
    this.streams.set(sessionId, handle);
    if (prev && prev !== handle) cancelHandle(sessionId, prev, 'force');
    return prev;
  }

  get(sessionId: string): SessionStreamHandle | undefined {
    return this.streams.get(sessionId);
  }

  /** 仅当当前句柄仍属于该轮（assistantMsgId 匹配）时移除，防误删新 run；返回是否移除 */
  release(sessionId: string, assistantMsgId: string): boolean {
    const cur = this.streams.get(sessionId);
    if (!cur || cur.assistantMsgId !== assistantMsgId) return false;
    this.streams.delete(sessionId);
    return true;
  }

  /** 移除并以 mode 取消当前句柄，重置其渲染缓冲；返回被取消的句柄 */
  cancel(
    sessionId: string,
    mode: StreamCancelMode
  ): SessionStreamHandle | undefined {
    const cur = this.streams.get(sessionId);
    if (!cur) return undefined;
    this.streams.delete(sessionId);
    cancelHandle(sessionId, cur, mode);
    return cur;
  }

  /** 按会话登记 starter；返回只解绑本次登记的函数 */
  bindStarter(sessionId: string, starter: StreamStarter): () => void {
    const stack = this.starters.get(sessionId) ?? [];
    stack.push(starter);
    // 重新插入使 Map 迭代序 = 登记先后（resolveStarter 取最近登记者）
    this.starters.delete(sessionId);
    this.starters.set(sessionId, stack);
    for (const [pendingSid, pending] of this.pendingStarts) {
      this.pendingStarts.delete(pendingSid);
      microtask(() =>
        this.startGuarded(pendingSid, pending.modelText, pending.userMsgId)
      );
    }
    return () => {
      const cur = this.starters.get(sessionId);
      if (!cur) return;
      const idx = cur.lastIndexOf(starter);
      if (idx >= 0) cur.splice(idx, 1);
      if (cur.length === 0) this.starters.delete(sessionId);
    };
  }

  /**
   * 在 onComplete 栈结束后启动下一轮（goal 续写 / drain）。
   * 执行时经 Double-Lock（墓碑 + Store 存活）守卫，再调用 resolveStarter 解析出的 starter。
   */
  scheduleStart(
    sessionId: string,
    modelText: string,
    userMsgId: string,
    schedule: StartScheduler = microtask
  ): void {
    schedule(() => this.startGuarded(sessionId, modelText, userMsgId));
  }

  markGoalCancelled(sessionId: string): void {
    this.goalCancelled.add(sessionId);
  }

  clearGoalCancelled(sessionId: string): void {
    this.goalCancelled.delete(sessionId);
  }

  /** 消费 goal-cancelled 标记（true = 本轮应跳过续写） */
  consumeGoalCancelled(sessionId: string): boolean {
    return this.goalCancelled.delete(sessionId);
  }

  beginDrain(sessionId: string): boolean {
    if (this.draining.has(sessionId)) return false;
    this.draining.add(sessionId);
    return true;
  }

  endDrain(sessionId: string): void {
    this.draining.delete(sessionId);
  }

  /** 注入 Store 存活探测；返回解绑函数 */
  bindSessionAliveOracle(oracle: (sessionId: string) => boolean): () => void {
    this.sessionAliveOracle = oracle;
    return () => {
      if (this.sessionAliveOracle === oracle) this.sessionAliveOracle = null;
    };
  }

  /**
   * 清理指定会话的全部追踪状态（句柄 / 挂起续写 / drain / goal-cancel / busyRetry）。
   * 不触发 cancel（取消走 `cancel`）；幂等。返回是否存在被遗弃的句柄。
   */
  clearSession(sessionId: string): boolean {
    const hadStream = this.streams.delete(sessionId);
    this.pendingStarts.delete(sessionId);
    this.draining.delete(sessionId);
    this.goalCancelled.delete(sessionId);
    clearBusyForSession(sessionId);
    return hadStream;
  }

  private startGuarded(
    sessionId: string,
    modelText: string,
    userMsgId: string
  ): void {
    if (isSessionTombstoned(sessionId)) {
      logger.info('[SessionStreamRegistry] session tombstoned; drop start', {
        module: MODULE,
        sessionId,
      });
      return;
    }
    if (this.sessionAliveOracle && !this.sessionAliveOracle(sessionId)) {
      logger.info('[SessionStreamRegistry] session not alive; drop start', {
        module: MODULE,
        sessionId,
      });
      return;
    }
    const starter = this.resolveStarter(sessionId);
    if (!starter) {
      this.pendingStarts.set(sessionId, { modelText, userMsgId });
      logger.info('[SessionStreamRegistry] no starter bound; start deferred', {
        module: MODULE,
        sessionId,
      });
      return;
    }
    starter(sessionId, modelText, userMsgId);
  }

  /** 该会话自己的 starter；无则取最近登记的任一 starter */
  private resolveStarter(sessionId: string): StreamStarter | undefined {
    const own = this.starters.get(sessionId)?.at(-1);
    if (own) return own;
    let latest: StreamStarter | undefined;
    for (const stack of this.starters.values()) latest = stack.at(-1);
    return latest;
  }
}

export type { SessionStreamRegistry };

/** 进程级唯一注册表 */
export const sessionStreams = new SessionStreamRegistry();

/** 测试用独立实例（不与进程级单例共享状态） */
export function createSessionStreamRegistryForTest(): SessionStreamRegistry {
  return new SessionStreamRegistry();
}
