/**
 * apps/crish-desktop/src/store/sessionCascadeCancellation.ts
 *
 * 三级级联取消总线 (Three-Tier Cascade Cancellation Bus)
 *
 * 依据详案：docs/full-stack-performance-audit/09-内存泄漏与生命周期管理优化实施详案.md §1.2 裁决 1 & Review-02 §4.4
 * 目的：彻底阻断 VULN-05 幽灵复活与脱缰泄漏。
 *
 * 三级取消保证：
 * - Tier 1 计算级 (Compute Tier)：通知 WorkerPool 立即终止属于该会话的计算/排队任务。
 * - Tier 2 通信级 (Transport Tier)：force 取消本地流句柄、清理流式缓冲，并经 runControlClient.abortSessionRun 通知 Rust 中止。
 * - Tier 3 存储屏障级 (Storage Barrier Tier)：维护容量为 500 的 LRU 墓碑集合，拦截一切迟到落盘。
 */

import { abortSessionRun } from '../api/runControlClient';
import { sessionStreams } from '../api/sessionStreamManager';
import { logger, toErrMeta } from '../services/LoggerService';
import {
  DEFAULT_TOMBSTONE_CAPACITY,
  bindSessionTombstoneOracle,
  getSharedTombstoneSet,
  setSharedTombstoneCapacity,
} from '../utils/lifecycle/ScopedLifecycleRegistry';
import { useStreamingStore } from './streamingStore';
import { dualLatchStateMachine } from './dualLatchProtocol';

export { DEFAULT_TOMBSTONE_CAPACITY };

export type WorkerCancelCallback = (sessionId: string) => void | Promise<void>;
export type TransportAbortCallback = (
  sessionId: string
) => void | Promise<void>;
export type StorageBarrierCallback = (
  sessionId: string
) => void | Promise<void>;

type CascadeTier = 'Tier1' | 'Tier2' | 'Tier3';

function reportCascadeFailure(
  tier: CascadeTier,
  step: string,
  sessionId: string,
  err: unknown
): void {
  logger.error(`[cascadeCancel:${tier}] ${step} failed`, {
    module: 'sessionCascadeCancellation',
    sessionId,
    err: toErrMeta(err),
  });
}

/**
 * 级联各步相互隔离：单步（同步抛错或异步 reject）失败只记录，不阻断后续步骤，
 * 保证删除会话时取消链完整走完。
 */
function runIsolated(
  tier: CascadeTier,
  step: string,
  sessionId: string,
  fn: () => void | Promise<void>
): void {
  try {
    const pending = fn();
    if (pending instanceof Promise) {
      pending.catch((err: unknown) => {
        reportCascadeFailure(tier, step, sessionId, err);
      });
    }
  } catch (err) {
    reportCascadeFailure(tier, step, sessionId, err);
  }
}

export interface WorkerCancelablePool {
  cancelBySession(sessionId: string): void;
}

export interface CascadeCancellationSubscriber {
  readonly id: string;
  readonly onWorkerCancel?: (sessionId: string) => void;
  readonly onTransportAbort?: (sessionId: string) => void;
  readonly onStorageBarrier?: (sessionId: string) => void;
}

export class SessionCascadeCancellation {
  /**
   * 容量为 500 的严格 LRU 墓碑集合。
   * 采用 Set 保留插入/刷新时序，超限时淘汰首个（最旧）记录。
   */
  public readonly tombstoneSessionIds: Set<string>;

  private maxCapacity: number;
  private readonly usesSharedTombstoneSet: boolean;
  private workerPool: WorkerCancelablePool | null = null;
  private readonly workerCancelCallbacks = new Set<WorkerCancelCallback>();
  private readonly transportAbortCallbacks = new Set<TransportAbortCallback>();
  private readonly storageBarrierCallbacks = new Set<StorageBarrierCallback>();
  private readonly subscribers = new Map<
    string,
    CascadeCancellationSubscriber
  >();

  constructor(
    maxCapacity: number = DEFAULT_TOMBSTONE_CAPACITY,
    useSharedBackingSet = false
  ) {
    this.maxCapacity = Math.max(1, maxCapacity);
    this.usesSharedTombstoneSet = useSharedBackingSet;
    this.tombstoneSessionIds = useSharedBackingSet
      ? getSharedTombstoneSet()
      : new Set<string>();
    if (useSharedBackingSet) {
      setSharedTombstoneCapacity(this.maxCapacity);
    }
  }

  /**
   * 注册 WorkerPool 实例（需具备 cancelBySession 接口）
   */
  public registerWorkerPool(pool: WorkerCancelablePool): () => void {
    this.workerPool = pool;
    return () => {
      if (this.workerPool === pool) {
        this.workerPool = null;
      }
    };
  }

  /**
   * 注册 Tier 1 Worker 取消回调函数
   */
  public registerWorkerCancelHandler(
    callback: WorkerCancelCallback
  ): () => void {
    this.workerCancelCallbacks.add(callback);
    return () => {
      this.workerCancelCallbacks.delete(callback);
    };
  }

  /**
   * 注册 Tier 2 通信/流式中止回调函数
   */
  public registerTransportAbortHandler(
    callback: TransportAbortCallback
  ): () => void {
    this.transportAbortCallbacks.add(callback);
    return () => {
      this.transportAbortCallbacks.delete(callback);
    };
  }

  /**
   * 注册 Tier 3 存储写屏障回调函数
   */
  public registerStorageBarrierHandler(
    callback: StorageBarrierCallback
  ): () => void {
    this.storageBarrierCallbacks.add(callback);
    return () => {
      this.storageBarrierCallbacks.delete(callback);
    };
  }

  /**
   * 注册全生命周期具名订阅者
   */
  public registerSubscriber(
    subscriber: CascadeCancellationSubscriber
  ): () => void {
    this.subscribers.set(subscriber.id, subscriber);
    return () => {
      this.subscribers.delete(subscriber.id);
    };
  }

  /**
   * 记录会话墓碑，遵循容量上限的严格 LRU 淘汰语义。
   */
  public recordTombstone(sessionId: string): void {
    const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!sid) return;

    if (this.tombstoneSessionIds.has(sid)) {
      // 命中已有墓碑：刷新时序，移至末尾（最热）
      this.tombstoneSessionIds.delete(sid);
      this.tombstoneSessionIds.add(sid);
      return;
    }

    if (this.tombstoneSessionIds.size >= this.maxCapacity) {
      // 达到容量阈值：淘汰最旧的记录
      const oldest = this.tombstoneSessionIds.values().next().value;
      if (oldest !== undefined) {
        this.tombstoneSessionIds.delete(oldest);
      }
    }
    this.tombstoneSessionIds.add(sid);
  }

  /**
   * 标记会话进入墓碑状态（recordTombstone 的标准语义别名，遵循 500 容量严格 LRU 语义）
   */
  public markSessionTombstone(sessionId: string): void {
    this.recordTombstone(sessionId);
  }

  /**
   * 检查会话是否已进入墓碑状态（Tier 3 存储屏障守卫）
   * 拦截任何针对已删会话的迟到写入（Late-Arrival Writes），根除幽灵复活。
   */
  public isSessionTombstoned(sessionId: string): boolean {
    const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!sid) return false;
    return this.tombstoneSessionIds.has(sid);
  }

  /**
   * 原子广播三级级联取消：
   * 1. Tier 1 计算级：通知 WorkerPool 取消正在计算的该会话任务；
   * 2. Tier 2 通信级：登记墓碑，force 取消本地流句柄，经 abortSessionRun 通知 Rust 中止；
   * 3. Tier 3 存储屏障级：向所有持久化写通道提供 isSessionTombstoned 拦截与广播通知。
   */
  public cancelSessionCascade(sessionId: string): void {
    const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!sid) return;

    // =========================================================================
    // 【Tier 1 计算级】通知 WorkerPool 取消正在计算的任务
    // =========================================================================
    this.executeTier1(sid);

    // =========================================================================
    // 【Tier 2 通信级】发送 abort 信号，清理活跃流句柄，并在墓碑集合中登记 sessionId
    // =========================================================================
    this.markSessionTombstone(sid);
    this.executeTier2(sid);

    // =========================================================================
    // 【Tier 3 存储屏障级】触发存储写屏障拦截通知
    // =========================================================================
    this.executeTier3(sid);
  }

  private executeTier1(sessionId: string): void {
    const pool = this.workerPool;
    if (pool && typeof pool.cancelBySession === 'function') {
      runIsolated('Tier1', 'worker pool cancel', sessionId, () =>
        pool.cancelBySession(sessionId)
      );
    }
    for (const cb of this.workerCancelCallbacks) {
      runIsolated('Tier1', 'callback', sessionId, () => cb(sessionId));
    }
    for (const sub of this.subscribers.values()) {
      const onWorkerCancel = sub.onWorkerCancel;
      if (!onWorkerCancel) continue;
      runIsolated('Tier1', `subscriber ${sub.id}`, sessionId, () =>
        onWorkerCancel(sessionId)
      );
    }
  }

  private executeTier2(sessionId: string): void {
    // 1. 本地流句柄 force 取消（含渲染缓冲重置）并清空该会话追踪状态
    sessionStreams.cancel(sessionId, 'force');
    sessionStreams.clearSession(sessionId);

    // 2. 清理前端流式状态缓冲（防追加）
    useStreamingStore.getState().clearSession(sessionId);

    // 3. 清空 DualLatch 历史记录与挂起 rAF
    runIsolated('Tier2', 'dual latch abort', sessionId, () =>
      dualLatchStateMachine.abortSession(sessionId)
    );

    // 4. 通信级回调与订阅者通知
    for (const cb of this.transportAbortCallbacks) {
      runIsolated('Tier2', 'callback', sessionId, () => cb(sessionId));
    }
    for (const sub of this.subscribers.values()) {
      const onTransportAbort = sub.onTransportAbort;
      if (!onTransportAbort) continue;
      runIsolated('Tier2', `subscriber ${sub.id}`, sessionId, () =>
        onTransportAbort(sessionId)
      );
    }

    // 5. 通知 Rust 后端中止该会话运行（单一出站通道；abortSessionRun 永不 reject）
    void abortSessionRun(sessionId);
  }

  private executeTier3(sessionId: string): void {
    for (const cb of this.storageBarrierCallbacks) {
      runIsolated('Tier3', 'callback', sessionId, () => cb(sessionId));
    }
    for (const sub of this.subscribers.values()) {
      const onStorageBarrier = sub.onStorageBarrier;
      if (!onStorageBarrier) continue;
      runIsolated('Tier3', `subscriber ${sub.id}`, sessionId, () =>
        onStorageBarrier(sessionId)
      );
    }
  }

  /**
   * 单测辅助：重置所有状态与回调
   */
  public resetForTest(): void {
    this.tombstoneSessionIds.clear();
    this.workerPool = null;
    this.workerCancelCallbacks.clear();
    this.transportAbortCallbacks.clear();
    this.storageBarrierCallbacks.clear();
    this.subscribers.clear();
    this.maxCapacity = DEFAULT_TOMBSTONE_CAPACITY;
    if (this.usesSharedTombstoneSet) {
      setSharedTombstoneCapacity(DEFAULT_TOMBSTONE_CAPACITY);
    }
  }

  /**
   * 单测辅助：调整最大容量
   */
  public setMaxCapacityForTest(capacity: number): void {
    this.maxCapacity = Math.max(1, capacity);
    if (this.usesSharedTombstoneSet) {
      setSharedTombstoneCapacity(this.maxCapacity);
    }
    while (this.tombstoneSessionIds.size > this.maxCapacity) {
      const oldest = this.tombstoneSessionIds.values().next().value;
      if (oldest !== undefined) {
        this.tombstoneSessionIds.delete(oldest);
      } else {
        break;
      }
    }
  }
}

/**
 * 全局单例（绑定跨层共享 500 容量 LRU 墓碑集合）
 */
export const sessionCascadeCancellation = new SessionCascadeCancellation(
  DEFAULT_TOMBSTONE_CAPACITY,
  true
);

bindSessionTombstoneOracle({
  isSessionTombstoned: (sessionId: string) =>
    sessionCascadeCancellation.isSessionTombstoned(sessionId),
  markSessionTombstone: (sessionId: string) =>
    sessionCascadeCancellation.markSessionTombstone(sessionId),
});

/**
 * 便捷导出函数：标记会话进入墓碑状态（500 容量严格 LRU 淘汰）
 */
export function markSessionTombstone(sessionId: string): void {
  sessionCascadeCancellation.markSessionTombstone(sessionId);
}

/**
 * 便捷导出函数：记录会话墓碑
 */
export function recordTombstone(sessionId: string): void {
  sessionCascadeCancellation.recordTombstone(sessionId);
}

/**
 * 便捷导出函数：检查会话是否已进入墓碑
 */
export function isSessionTombstoned(sessionId: string): boolean {
  return sessionCascadeCancellation.isSessionTombstoned(sessionId);
}

/**
 * 便捷导出函数：触发级联取消
 */
export function cancelSessionCascade(sessionId: string): void {
  sessionCascadeCancellation.cancelSessionCascade(sessionId);
}
