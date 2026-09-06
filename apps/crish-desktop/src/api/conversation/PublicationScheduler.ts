import type {
  ConversationSnapshot,
  PublicationRhythm,
} from './types';

export type { ConversationSnapshot, PublicationRhythm };

/**
 * 快照发布回调函数签名
 */
export type PublishCallback<TSnapshot = ConversationSnapshot> = (
  snapshot: TSnapshot
) => void;

/**
 * 快照解析器函数签名（惰性物化求值）
 */
export type SnapshotGetter<TSnapshot = ConversationSnapshot> = () => TSnapshot;

/**
 * PublicationScheduler 初始化配置项
 */
export interface PublicationSchedulerOptions<TSnapshot = ConversationSnapshot> {
  /** 统一物化发布回调 */
  readonly onPublish: PublishCallback<TSnapshot>;
  /** 默认快照获取器（可选） */
  readonly getSnapshot?: SnapshotGetter<TSnapshot>;
}

/**
 * 高性能 3-RAF 节流发布管线 (PublicationScheduler)
 *
 * 核心契约与算法严格遵循 docs/linear-chat-stream-convergence/01-维度详案-数据链路单轨化与列表Props解耦.md §1.2：
 * 1. 跨 3 帧合流（3-RAF，约 48ms - 50ms）批处理：
 *    - 在首帧标记 dirty (hasPendingPublication)；
 *    - 经历 3 帧 requestAnimationFrame 节流平抑后，统一触发 onPublish(snapshot) 回调；
 *    - 彻底平抑千字思考链与高频 Token 流水线（60~120 chunk/s）带来的 React 重渲染风暴与测高风暴；
 * 2. 惰性物化（Lazy Materialization）：
 *    - 调度期仅保存最新的快照解析函数 getSnapshot，仅在第 3 帧真正发布时求值一次；
 *    - 避免逐 chunk 创建中间对象，大幅降低 GC 压力；
 * 3. 关键落定事件零延迟（Immediate Preemption）：
 *    - 遇到 message_end、tool_call、error 等关键终态事件，立即取消排队帧，当前宏任务同步物化并发布；
 *    - 瞬时重置 3-RAF 帧计数，绝无毫秒级状态滞后；
 * 4. 静默折叠（none）：
 *    - 仅吸收更新内部最新快照提供者，不排队、不调度渲染；
 * 5. 优雅降级与 GC 防泄漏：
 *    - 非浏览器/测试环境优雅降级为 setTimeout(..., 16)；
 *    - 提供 flush 强制立即清空并发布；
 *    - 提供 dispose 取消未决帧/定时器并释放闭包引用与内存。
 */
export class PublicationScheduler<TSnapshot = ConversationSnapshot> {
  private onPublish: PublishCallback<TSnapshot>;
  private pendingGetSnapshot: SnapshotGetter<TSnapshot> | null = null;
  private defaultGetSnapshot: SnapshotGetter<TSnapshot> | null = null;

  private rafId: number | null = null;
  private rafCount = 0;
  private hasPendingPublication = false;
  private isDisposed = false;

  constructor(
    init:
      | PublishCallback<TSnapshot>
      | PublicationSchedulerOptions<TSnapshot>
  ) {
    if (typeof init === 'function') {
      this.onPublish = init;
    } else {
      this.onPublish = init.onPublish;
      if (init.getSnapshot) {
        this.defaultGetSnapshot = init.getSnapshot;
      }
    }
  }

  /**
   * 接收来自状态机或数据源的发布调度诉求
   *
   * @param rhythm 发布节奏：'none' | 'animation-frame' | 'immediate'
   * @param getSnapshot 可选的当前最新快照惰性获取函数
   */
  public schedule(
    rhythm: PublicationRhythm,
    getSnapshot?: SnapshotGetter<TSnapshot>
  ): void {
    if (this.isDisposed) {
      return;
    }

    if (rhythm === 'none') {
      // 静默折叠：不调度渲染；若当前已有挂起的合流任务，更新其快照提供者以便合流时取到最新状态
      if (getSnapshot && this.hasPendingPublication) {
        this.pendingGetSnapshot = getSnapshot;
      }
      return;
    }

    if (rhythm === 'immediate') {
      // 关键终态事件：立即切断排队帧，同步触发发布并重置 3-RAF 计数
      const getter =
        getSnapshot ?? this.pendingGetSnapshot ?? this.defaultGetSnapshot;
      this.cancelPending();

      if (getter) {
        const snapshot = getter();
        this.onPublish(snapshot);
      } else {
        (this.onPublish as unknown as () => void)();
      }
      return;
    }

    // animation-frame 节奏：跨 3 个 requestAnimationFrame 合流
    this.hasPendingPublication = true;
    if (getSnapshot) {
      this.pendingGetSnapshot = getSnapshot;
    }

    if (this.rafId === null) {
      this.scheduleNextRaf();
    }
  }

  /**
   * 强制立即清空并发布挂起的待处理快照
   */
  public flush(): void {
    if (this.isDisposed) {
      return;
    }

    const wasPending = this.hasPendingPublication || this.rafId !== null;
    const getter = this.pendingGetSnapshot ?? this.defaultGetSnapshot;
    this.cancelPending();

    if (wasPending) {
      if (getter) {
        const snapshot = getter();
        this.onPublish(snapshot);
      } else {
        (this.onPublish as unknown as () => void)();
      }
    }
  }

  /**
   * 取消未决帧与挂起状态，重置 3-RAF 计数
   */
  public cancelPending(): void {
    if (this.rafId !== null) {
      this.cancelFrame(this.rafId);
      this.rafId = null;
    }
    this.rafCount = 0;
    this.hasPendingPublication = false;
    this.pendingGetSnapshot = null;
  }

  /**
   * 销毁调度器，取消未决定时器并彻底释放闭包引用与内存
   */
  public dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.cancelPending();
    this.isDisposed = true;
    this.pendingGetSnapshot = null;
    this.defaultGetSnapshot = null;
    this.onPublish = () => {};
  }

  /** 是否有待发布的合流任务正在挂起中 */
  public get isPending(): boolean {
    return this.hasPendingPublication;
  }

  /** 当前 3-RAF 帧累积计数（0, 1, 2） */
  public get currentFrameCount(): number {
    return this.rafCount;
  }

  /** 调度器是否已被销毁 */
  public get disposed(): boolean {
    return this.isDisposed;
  }

  // ────────────────── 内部私有调度机制 ──────────────────

  private scheduleNextRaf(): void {
    if (this.isDisposed) {
      return;
    }

    this.rafId = this.requestFrame(() => {
      if (this.isDisposed) {
        this.rafId = null;
        return;
      }

      this.rafCount++;
      if (this.rafCount >= 3) {
        // 达到 3 帧门限（在 60Hz 屏幕约 48ms - 50ms），合流物化快照
        this.rafId = null;
        this.rafCount = 0;

        if (this.hasPendingPublication) {
          this.hasPendingPublication = false;
          const getter =
            this.pendingGetSnapshot ?? this.defaultGetSnapshot;
          this.pendingGetSnapshot = null;

          if (getter) {
            const snapshot = getter();
            this.onPublish(snapshot);
          } else {
            (this.onPublish as unknown as () => void)();
          }
        }
      } else {
        // 未满 3 帧，继续进入下一帧循环
        this.scheduleNextRaf();
      }
    });
  }

  private requestFrame(callback: () => void): number {
    if (
      typeof globalThis !== 'undefined' &&
      typeof globalThis.requestAnimationFrame === 'function'
    ) {
      return globalThis.requestAnimationFrame(callback);
    }
    if (typeof requestAnimationFrame === 'function') {
      return requestAnimationFrame(callback);
    }
    // 非浏览器环境优雅降级为 16ms setTimeout
    return setTimeout(callback, 16) as unknown as number;
  }

  private cancelFrame(id: number): void {
    if (
      typeof globalThis !== 'undefined' &&
      typeof globalThis.cancelAnimationFrame === 'function'
    ) {
      globalThis.cancelAnimationFrame(id);
      return;
    }
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(id);
      return;
    }
    clearTimeout(id as unknown as any);
  }
}
