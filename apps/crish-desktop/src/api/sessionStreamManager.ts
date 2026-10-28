/**
 * 按会话隔离的流式 run 句柄 + 续写调度。
 * 将 cancel/drain/goal-cancel/续写从 useChatStream 四 ref 隐式状态机收口到一处。
 */

import type { StreamCancelFn } from './chat-bridge/ConnectionLifecycle';
import { logger } from '../services/LoggerService';
import { isSessionTombstoned } from '../utils/lifecycle/ScopedLifecycleRegistry';

export type {
  StreamCancelFn,
  StreamCancelMode,
} from './chat-bridge/ConnectionLifecycle';

export type SessionStreamHandle = {
  /** 支持 L2 cooperative / L3 force；无参时按 force（旧调用兼容） */
  cancel: StreamCancelFn;
  userMsgId: string;
  assistantMsgId: string;
  runId: string | null;
};

export type StreamStarter = (
  input: string,
  userMsgId: string,
  sessionIdOverride?: string
) => void;

export type PendingContinue = {
  sessionId: string;
  modelText: string;
  userMsgId: string;
};

/**
 * 串行守卫（S7 / SESSION_BUSY）自动排队的退避重试计数（FINAL-PLAN P1-d 方案 B）。
 *
 * - 运行时、不持久化：userMsgId → { sessionId, attempt }；
 * - streamSession 的 S7 分支 noteBusy（第 n 次被拒）；run 被后端受理 / 用尽 /
 *   会话清理时 clearBusy；
 * - drain（useGoalMode.drainQueuedAfterComplete）按 attempt 计算退避：
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

export class SessionStreamManager {
  private streams = new Map<string, SessionStreamHandle>();
  private draining = new Set<string>();
  /** 用户停止后禁止该会话 goal 自动续写（一次性消费） */
  private goalCancelled = new Set<string>();
  /** 由 hook 每轮渲染绑定最新 starter，续写走 queueMicrotask 调用绑定值 */
  private starter: StreamStarter | null = null;

  /** 绑定当前 hook 的 runStreamingAssistant（每 render 更新，避免 setTimeout 抓到 undefined） */
  private sessionAliveOracle: ((sessionId: string) => boolean) | null = null;

  /** 绑定存活探测断言闭包（避免直接反向依赖 Store 内部实现，符合 depcruise 契约） */
  bindSessionAliveOracle(
    oracle: ((sessionId: string) => boolean) | null
  ): void {
    this.sessionAliveOracle = oracle;
  }

  bindStarter(fn: StreamStarter): void {
    this.starter = fn;
  }

  get(sessionId: string): SessionStreamHandle | undefined {
    return this.streams.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.streams.has(sessionId);
  }

  hasStream(sessionId: string): boolean {
    return this.streams.has(sessionId);
  }

  set(sessionId: string, handle: SessionStreamHandle): void {
    this.streams.set(sessionId, handle);
  }

  delete(sessionId: string): void {
    this.streams.delete(sessionId);
  }

  /** 替换同会话流前先 cancel 旧句柄，避免幽灵 run */
  replace(
    sessionId: string,
    next: SessionStreamHandle
  ): SessionStreamHandle | undefined {
    const prev = this.streams.get(sessionId);
    if (prev) {
      this.streams.delete(sessionId);
      try {
        prev.cancel();
      } catch {
        /* swallow-ok: 旧流已结束/销毁时 cancel 失败可忽略，新流正常接管 */
      }
    }
    this.streams.set(sessionId, next);
    return prev;
  }

  /** cancel 并移除；返回被取消的句柄 */
  cancelSession(sessionId: string): SessionStreamHandle | undefined {
    const cur = this.streams.get(sessionId);
    if (!cur) return undefined;
    this.streams.delete(sessionId);
    try {
      cur.cancel();
    } catch {
      /* swallow-ok: 流已结束/销毁时 cancel 失败可忽略，句柄已移除 */
    }
    return cur;
  }

  markGoalCancelled(sessionId: string): void {
    this.goalCancelled.add(sessionId);
  }

  clearGoalCancelled(sessionId: string): void {
    this.goalCancelled.delete(sessionId);
  }

  /** 消费 goal-cancelled 标记（true = 本轮应跳过续写） */
  consumeGoalCancelled(sessionId: string): boolean {
    if (!this.goalCancelled.has(sessionId)) return false;
    this.goalCancelled.delete(sessionId);
    return true;
  }

  beginDrain(sessionId: string): boolean {
    if (this.draining.has(sessionId)) return false;
    this.draining.add(sessionId);
    return true;
  }

  endDrain(sessionId: string): void {
    this.draining.delete(sessionId);
  }

  endDrainNextTick(
    sessionId: string,
    schedule: (fn: () => void) => void = (fn) => queueMicrotask(fn)
  ): void {
    schedule(() => {
      this.draining.delete(sessionId);
    });
  }

  /**
   * 在 onComplete 栈结束后启动下一轮（goal 续写 / drain）。
   * 使用 queueMicrotask + 当前 bindStarter，避免 setTimeout(0)+ref 被替换时丢调用。
   */
  scheduleStart(
    sessionId: string,
    modelText: string,
    userMsgId: string,
    schedule: (fn: () => void) => void = (fn) => queueMicrotask(fn)
  ): void {
    schedule(() => {
      // 【Double-Lock 双重守卫】：1. 墓碑黑名单守卫
      if (isSessionTombstoned(sessionId)) {
        logger.info(
          '[SessionStreamManager] session tombstoned; cancel scheduled start',
          {
            module: 'SessionStreamManager',
            sessionId,
          }
        );
        return;
      }
      // 2. Store 存活性二次校验（防御 LRU 墓碑驱逐后长延迟定时器执行）
      if (this.sessionAliveOracle && !this.sessionAliveOracle(sessionId)) {
        logger.info(
          '[SessionStreamManager] session not alive in store; drop scheduled start',
          {
            module: 'SessionStreamManager',
            sessionId,
          }
        );
        return;
      }
      const start = this.starter;
      if (!start) {
        logger.warn('[SessionStreamManager] starter not bound; drop continue', {
          module: 'SessionStreamManager',
          sessionId,
        });
        return;
      }
      start(modelText, userMsgId, sessionId);
    });
  }

  /**
   * 清理指定会话的全部追踪状态（streams / draining / goalCancelled / busyRetry）。
   *
   * 异常路径兜底：当流异常中断（onRunError）或会话被销毁时，
   * streams Map 与 draining/goalCancelled Set 会累积孤儿条目。
   * 调用此方法保证单会话维度的全量清理。
   *
   * 幂等：对不存在的 sessionId 调用不报错，多次调用安全。
   * 注意：不会触发 cancel 回调（与 cancelSession 不同）；仅清理追踪状态。
   * 返回是否存在被遗弃的活跃流（供调用方决定是否 cancel）。
   */
  clearSession(sessionId: string): boolean {
    const hadStream = this.streams.has(sessionId);
    this.streams.delete(sessionId);
    this.draining.delete(sessionId);
    this.goalCancelled.delete(sessionId);
    clearBusyForSession(sessionId);
    return hadStream;
  }

  /**
   * 清理全部追踪状态（hook 卸载 / 进程退出时使用）。
   *
   * 注意：不会触发 cancel 回调；调用方应先遍历 streams 自行 cancel。
   * 幂等：空状态调用安全。
   */
  dispose(): void {
    this.streams.clear();
    this.draining.clear();
    this.goalCancelled.clear();
    busyRetry.clear();
    this.starter = null;
    this.sessionAliveOracle = null;
  }
}
