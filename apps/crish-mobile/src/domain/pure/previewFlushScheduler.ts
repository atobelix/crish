// preview 帧渲染节流调度器（R2UX-05-02 流式文本 / F3 §3.4.1 高频事件节流与合并）：
// - 合并窗口（mergeWindowMs，缺省 18）：同一窗口内到达的多帧（同 key 全文覆盖式——
//   预览帧语义，同 seq 只保留最新值）合并为**一次** flush 渲染；
// - 强制刷新边界（maxWaitMs，缺省 100）：连续帧流中窗口被反复重置时，保证从
//   本波帧流开始最多等待 maxWaitMs 必然渲染一次（T20 delta 可见延迟 ≤100ms 兜底）；
// - 终值立即刷新（push final / flushNow）：message-end / tool-end / run-terminal 等
//   终态到达时立即 flush，不延迟一拍（F3 §3.4.1 终态强制 flushNow / R2UX §2.6-1）；
// - 定时器工厂可注入（setTimer/clearTimer）：jest 假定时器直测（纯逻辑零副作用）。
// 与桌面端先例（streamTextBatcher.ts，48ms 窗口 + 批合并）同构：
// 本调度器将桌面「leading-edge 窗口」调整为「滚动窗口 + 强制刷新边界」——
// 移动端帧流更密，滚动窗口合并短突发、maxWait 保证长流的渲染节奏。
export interface PreviewFlushSchedulerOptions {
  /** 合并窗口（ms，缺省 18；≤0 = 每帧立即 flush 的同步路径，测试旁路用） */
  mergeWindowMs?: number;
  /** 强制刷新边界（ms，缺省 100；≤0 = 禁用强制刷新，纯滚动窗口） */
  maxWaitMs?: number;
  /** 定时器工厂（可测；缺省 setTimeout/clearTimeout） */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
}

export interface PreviewPushOptions {
  /** 终值帧：立即 flush 全部 pending（F3 §3.4.1 终态强制 flushNow 语义） */
  final?: boolean;
}

/** 合并窗口缺省值（R2UX-05-02 任务口径：18ms 内合并多帧） */
export const PREVIEW_MERGE_WINDOW_MS = 18;
/** 强制刷新边界缺省值（100ms：连续帧流至少每 100ms 渲染一次，T20 ≤100ms 兜底） */
export const PREVIEW_MAX_WAIT_MS = 100;

/**
 * preview 帧渲染节流调度器（纯逻辑，零 React 依赖；jest 直测）：
 * - push：同 key 全文覆盖（预览帧覆盖式语义）；首帧开启本波合并窗口 + 强制刷新边界；
 *   后续帧重置合并窗口（滚动），强制刷新边界不延长（本波从首帧计时）；
 * - 终值帧（final）或手动 flushNow：立即清空全部 pending 并回调，不留待渲染帧；
 * - 回调内再 push 的 re-entrant 保护：flush 收尾自动接续下一窗口（桌面同款 flushDepth）。
 */
export class PreviewFlushScheduler {
  private readonly onFlush: (key: string, value: string) => void;
  private readonly mergeWindowMs: number;
  private readonly maxWaitMs: number;
  private readonly setTimer: (
    fn: () => void,
    ms: number
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (id: ReturnType<typeof setTimeout>) => void;

  private readonly pending = new Map<string, string>();
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  /** 回调内 re-entrant flushNow / push 的防嵌套守卫（桌面 StreamValueBatcher 同款） */
  private flushDepth = 0;
  private flushAgain = false;

  constructor(
    onFlush: (key: string, value: string) => void,
    options: PreviewFlushSchedulerOptions = {}
  ) {
    this.onFlush = onFlush;
    const rawWindow = options.mergeWindowMs ?? PREVIEW_MERGE_WINDOW_MS;
    this.mergeWindowMs = Number.isFinite(rawWindow)
      ? rawWindow
      : PREVIEW_MERGE_WINDOW_MS;
    const rawMaxWait = options.maxWaitMs ?? PREVIEW_MAX_WAIT_MS;
    this.maxWaitMs = Number.isFinite(rawMaxWait)
      ? rawMaxWait
      : PREVIEW_MAX_WAIT_MS;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ??
      ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  }

  /** 推入最新全文（同 key 覆盖式合并，预览帧语义）；final=true 立即 flush */
  push(key: string, value: string, opts: PreviewPushOptions = {}): void {
    this.pending.set(key, value);
    // 终值帧（message-end 等）与同步路径（窗口 ≤0）：立即刷出不延迟一拍
    if (opts.final || this.mergeWindowMs <= 0) {
      this.flushNow();
      return;
    }
    // flush 回调内 push：由 flushNow 收尾统一接续下一窗口，勿双重排程
    if (this.flushDepth > 0) return;
    this.scheduleWindow();
    this.scheduleMaxWait();
  }

  /** 立即刷出全部 pending（终态 / unmount 前显式调用；同 key 只回调最新值） */
  flushNow(): void {
    this.clearWindowTimer();
    this.clearMaxWaitTimer();
    if (this.flushDepth > 0) {
      // 嵌套调用：标记外层 flush 结束后再刷一轮（含回调内 flushNow）
      this.flushAgain = true;
      return;
    }
    do {
      this.flushAgain = false;
      this.flushDepth += 1;
      try {
        this.flushPendingOnce();
      } finally {
        this.flushDepth -= 1;
      }
    } while (this.flushAgain);

    // flush 期间回调 push 的新帧：接续下一合并窗口（re-entrant 不丢帧）
    if (this.pending.size > 0) {
      if (this.mergeWindowMs <= 0) {
        // 同步路径：继续刷到空（仅一轮额外刷，防回调无限 push 死循环）
        this.flushDepth += 1;
        try {
          this.flushPendingOnce();
        } finally {
          this.flushDepth -= 1;
        }
      } else {
        this.scheduleWindow();
        this.scheduleMaxWait();
      }
    }
  }

  /** 丢弃某 key 的 pending（消息被撤回）；pending 空则取消全部定时器 */
  drop(key: string): void {
    this.pending.delete(key);
    if (this.pending.size === 0) {
      this.clearWindowTimer();
      this.clearMaxWaitTimer();
    }
  }

  /** 取消/重置：丢弃全部 pending 并清定时器，不触发回调；实例可继续复用 */
  reset(): void {
    this.clearWindowTimer();
    this.clearMaxWaitTimer();
    this.pending.clear();
    this.flushAgain = false;
  }

  /** 当前待刷 key 数（测试 / 诊断） */
  pendingCount(): number {
    return this.pending.size;
  }

  /** 是否有指定 key（缺省任意 key）待刷 */
  hasPending(key?: string): boolean {
    if (key === undefined) return this.pending.size > 0;
    return this.pending.has(key);
  }

  /** 是否已排程定时器（合并窗口或强制刷新边界任一存活） */
  isScheduled(): boolean {
    return this.windowTimer !== null || this.maxWaitTimer !== null;
  }

  /** 滚动窗口：每次 push 重置（18ms 内多帧合并为一次渲染） */
  private scheduleWindow(): void {
    this.clearWindowTimer();
    this.windowTimer = this.setTimer(() => {
      this.windowTimer = null;
      this.flushNow();
    }, this.mergeWindowMs);
  }

  /** 强制刷新边界：本波首帧开启，不随滚动窗口延长（长流保证渲染节奏） */
  private scheduleMaxWait(): void {
    if (this.maxWaitMs <= 0 || this.maxWaitTimer !== null) return;
    this.maxWaitTimer = this.setTimer(() => {
      this.maxWaitTimer = null;
      this.flushNow();
    }, this.maxWaitMs);
  }

  private clearWindowTimer(): void {
    if (this.windowTimer !== null) {
      this.clearTimer(this.windowTimer);
      this.windowTimer = null;
    }
  }

  private clearMaxWaitTimer(): void {
    if (this.maxWaitTimer !== null) {
      this.clearTimer(this.maxWaitTimer);
      this.maxWaitTimer = null;
    }
  }

  /**
   * 单轮快照 flush：先拷贝再清空，回调内 push 进入新 pending；
   * 回调抛错：失败项 + 其后未刷项回填（同 key 已有更新则保留更新），错误上抛。
   */
  private flushPendingOnce(): void {
    if (this.pending.size === 0) return;
    const entries = [...this.pending.entries()];
    this.pending.clear();
    let i = 0;
    try {
      for (; i < entries.length; i += 1) {
        const [key, value] = entries[i]!;
        this.onFlush(key, value);
      }
    } catch (err) {
      for (let j = i; j < entries.length; j += 1) {
        const [key, value] = entries[j]!;
        if (!this.pending.has(key)) this.pending.set(key, value);
      }
      throw err;
    }
  }
}
