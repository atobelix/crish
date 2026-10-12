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
 * - Tier 2 通信级 (Transport Tier)：向 Rust 发送 abort 信号，注销流式监听并丢弃在途帧。
 * - Tier 3 存储屏障级 (Storage Barrier Tier)：维护容量为 500 的 LRU 墓碑集合，拦截一切迟到落盘。
 */

import { sharedSessionStreamManager } from '../hooks/chat-stream/sessionStreamManager';
import { useStreamingStore } from './streamingStore';

export const DEFAULT_TOMBSTONE_CAPACITY = 500;

export type WorkerCancelCallback = (sessionId: string) => void | Promise<void>;
export type TransportAbortCallback = (
  sessionId: string
) => void | Promise<void>;
export type StorageBarrierCallback = (
  sessionId: string
) => void | Promise<void>;

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
   * 容量为 500 的 LRU 墓碑集合。
   * 采用 Set 保留插入/刷新时序，超限时淘汰首个（最旧）记录。
   */
  public readonly tombstoneSessionIds = new Set<string>();

  private maxCapacity: number;
  private workerPool: WorkerCancelablePool | null = null;
  private readonly workerCancelCallbacks = new Set<WorkerCancelCallback>();
  private readonly transportAbortCallbacks = new Set<TransportAbortCallback>();
  private readonly storageBarrierCallbacks = new Set<StorageBarrierCallback>();
  private readonly subscribers = new Map<
    string,
    CascadeCancellationSubscriber
  >();

  constructor(maxCapacity: number = DEFAULT_TOMBSTONE_CAPACITY) {
    this.maxCapacity = Math.max(1, maxCapacity);
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
   * 记录会话墓碑，遵循容量上限的 LRU 淘汰语义。
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
   * 2. Tier 2 通信级：向 Rust 后端发出 abort 信号（调用 workbench_abort_run 或注销流监听），并在墓碑集合中登记 sessionId；
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
    this.recordTombstone(sid);
    this.executeTier2(sid);

    // =========================================================================
    // 【Tier 3 存储屏障级】触发存储写屏障拦截通知
    // =========================================================================
    this.executeTier3(sid);
  }

  private executeTier1(sessionId: string): void {
    if (
      this.workerPool &&
      typeof this.workerPool.cancelBySession === 'function'
    ) {
      try {
        this.workerPool.cancelBySession(sessionId);
      } catch (err) {
        console.error(
          `[sessionCascadeCancellation:Tier1] WorkerPool cancel failed for ${sessionId}:`,
          err
        );
      }
    }

    for (const cb of this.workerCancelCallbacks) {
      try {
        void cb(sessionId);
      } catch (err) {
        console.error(
          `[sessionCascadeCancellation:Tier1] Callback failed for ${sessionId}:`,
          err
        );
      }
    }

    for (const sub of this.subscribers.values()) {
      if (sub.onWorkerCancel) {
        try {
          sub.onWorkerCancel(sessionId);
        } catch (err) {
          console.error(
            `[sessionCascadeCancellation:Tier1] Subscriber ${sub.id} failed for ${sessionId}:`,
            err
          );
        }
      }
    }
  }

  private executeTier2(sessionId: string): void {
    // 1. 本地流管理取消与清空
    try {
      sharedSessionStreamManager.cancelSession(sessionId);
      sharedSessionStreamManager.clearSession(sessionId);
    } catch {
      // 容错处理
    }

    // 2. 清理前端流式状态缓冲（防追加）
    try {
      useStreamingStore.getState().clearSession(sessionId);
    } catch {
      // 容错处理
    }

    // 3. 通信级回调与订阅者通知
    for (const cb of this.transportAbortCallbacks) {
      try {
        void cb(sessionId);
      } catch (err) {
        console.error(
          `[sessionCascadeCancellation:Tier2] Callback failed for ${sessionId}:`,
          err
        );
      }
    }

    for (const sub of this.subscribers.values()) {
      if (sub.onTransportAbort) {
        try {
          sub.onTransportAbort(sessionId);
        } catch (err) {
          console.error(
            `[sessionCascadeCancellation:Tier2] Subscriber ${sub.id} failed for ${sessionId}:`,
            err
          );
        }
      }
    }

    // 4. 发出 Rust 后端 abort 信号（workbench_abort_run）
    this.sendRustAbortSignal(sessionId);
  }

  private sendRustAbortSignal(sessionId: string): void {
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('workbench_abort_run', { sessionId });
      } catch {
        // 在开发环境或非 Tauri 宿主中静默容错
      }
    })();
  }

  private executeTier3(sessionId: string): void {
    for (const cb of this.storageBarrierCallbacks) {
      try {
        void cb(sessionId);
      } catch (err) {
        console.error(
          `[sessionCascadeCancellation:Tier3] Callback failed for ${sessionId}:`,
          err
        );
      }
    }

    for (const sub of this.subscribers.values()) {
      if (sub.onStorageBarrier) {
        try {
          sub.onStorageBarrier(sessionId);
        } catch (err) {
          console.error(
            `[sessionCascadeCancellation:Tier3] Subscriber ${sub.id} failed for ${sessionId}:`,
            err
          );
        }
      }
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
  }

  /**
   * 单测辅助：调整最大容量
   */
  public setMaxCapacityForTest(capacity: number): void {
    this.maxCapacity = Math.max(1, capacity);
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
 * 全局单例
 */
export const sessionCascadeCancellation = new SessionCascadeCancellation();

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
