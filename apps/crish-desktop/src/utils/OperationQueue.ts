/**
 * OperationQueue —— 按 session 隔离的操作队列
 *
 * 职责：
 * - 每个 session 独立 FIFO 队列，同一 session 同时最多一个操作在执行
 * - enqueue 返回 Promise，操作完成时 resolve，被取消时 reject
 * - 高 priority 操作插队（priority 越大越先执行）
 * - 支持按 session 取消待处理操作
 */

export type OperationType =
  | 'send-message'
  | 'stop-generation'
  | 'approve-tool'
  | 'deny-tool'
  | 'switch-session'
  | 'close-tab'
  | 'regenerate';

interface PendingOperation {
  id: string;
  type: OperationType;
  sessionId: string;
  execute: () => Promise<void>;
  priority: number;
  createdAt: number;
  resolve: (value: void | PromiseLike<void>) => void;
  reject: (reason?: unknown) => void;
}

export class OperationQueue {
  /** 每个 session 独立的待处理队列 */
  private queues = new Map<string, PendingOperation[]>();

  /** 当前正在执行操作的 session 集合 */
  private running = new Set<string>();

  /** 自增计数器，用于生成唯一操作 ID */
  private nextId = 0;

  /**
   * 入队一个操作。
   * @param sessionId 所属会话 ID
   * @param type      操作类型
   * @param execute   实际执行函数
   * @param priority  优先级（默认 0，越大越先执行）
   * @returns Promise，操作完成时 resolve，被取消时 reject
   */
  enqueue(
    sessionId: string,
    type: OperationType,
    execute: () => Promise<void>,
    priority = 0,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const operation: PendingOperation = {
        id: `op_${++this.nextId}`,
        type,
        sessionId,
        execute,
        priority,
        createdAt: Date.now(),
        resolve,
        reject,
      };

      const queue = this.queues.get(sessionId);
      if (!queue) {
        this.queues.set(sessionId, [operation]);
        this.tryProcessNext(sessionId);
      } else {
        this.insertByPriority(queue, operation);
        if (!this.running.has(sessionId)) {
          this.tryProcessNext(sessionId);
        }
      }
    });
  }

  /**
   * 取消某个 session 的所有待处理操作。
   * 不会中断正在执行的操作，仅清空队列中尚未执行的操作。
   */
  cancelSession(sessionId: string): void {
    const queue = this.queues.get(sessionId);
    if (queue) {
      this.queues.delete(sessionId);
      for (const op of queue) {
        op.reject(new Error(`操作已取消: session ${sessionId}`));
      }
    }
  }

  /** 检查某个 session 当前是否有操作正在执行 */
  isBusy(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  /** 检查某个 session 是否有待处理操作（不含正在执行的操作） */
  hasPending(sessionId: string): boolean {
    const queue = this.queues.get(sessionId);
    return queue != null && queue.length > 0;
  }

  /** 清空所有队列，废弃所有待处理操作 */
  clear(): void {
    for (const queue of this.queues.values()) {
      for (const op of queue) {
        op.reject(new Error('操作队列已清空'));
      }
    }
    this.queues.clear();
    this.running.clear();
  }

  /** 尝试处理下一个操作：session 空闲且队列非空时取出并执行 */
  private tryProcessNext(sessionId: string): void {
    if (this.running.has(sessionId)) return;

    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) return;

    const operation = queue.shift()!;
    this.running.add(operation.sessionId);

    operation.execute().then(
      () => {
        operation.resolve();
        this.onOperationComplete(sessionId);
      },
      (error) => {
        operation.reject(error);
        this.onOperationComplete(sessionId);
      },
    );
  }

  /** 操作完成后清理状态，然后处理队列中的下一个操作 */
  private onOperationComplete(sessionId: string): void {
    this.running.delete(sessionId);
    this.tryProcessNext(sessionId);
  }

  /**
   * 按优先级降序插入到队列中。
   * 同优先级的操作保持先入先出顺序。
   */
  private insertByPriority(queue: PendingOperation[], operation: PendingOperation): void {
    let i = queue.length;
    while (i > 0 && queue[i - 1]!.priority < operation.priority) {
      i--;
    }
    queue.splice(i, 0, operation);
  }
}
