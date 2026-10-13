/**
 * 流式更新批合并：processing 期间将高频更新合并为短间隔一次 flush，
 * 降低 store/UI 提交频率；complete/cancel 时必须 flushNow 保证终态不丢。
 *
 * - StreamTextBatcher：正文 / thinking 全文覆盖（保持既有 API）
 * - StreamValueBatcher：通用按 key 合并（工具 patch 等）
 *
 * 定时模型：leading-edge——首次 push 启动 interval，窗口内同 key 合并，
 * 到期 flush 后下一 push 再开新窗口。force flush（max buffer / flushNow）
 * 会清定时器并立即写出。
 */

import type { MessageToolCall } from '../store/types';

export type StreamValueFlush<T> = (key: string, value: T) => void;

export type StreamValueBatcherOptions<T> = {
  /** 合并间隔（ms），默认 48；≤0 表示 push 后立即 flush（仍会先合并同 tick 内多次 push 需配合手动 flushNow） */
  intervalMs?: number | undefined;
  /** 定时器工厂（可测） */
  setTimer?:
    ((fn: () => void, ms: number) => ReturnType<typeof setTimeout>) | undefined;
  clearTimer?: ((id: ReturnType<typeof setTimeout>) => void) | undefined;
  /** 同 key 再次 push 时合并；默认覆盖为最新值 */
  merge?: ((prev: T, next: T) => T) | undefined;
  /**
   * pending key 数达到此上限时强制 flushNow，防止 key 膨胀拖延迟。
   * 未设置则不限制。
   */
  maxPendingKeys?: number | undefined;
  /**
   * pending 累计 size 达到此上限时强制 flushNow。
   * size 由 estimateSize 计算；未设置则不限制。
   */
  maxBufferedSize?: number | undefined;
  /**
   * 单条 pending 的 size 估算；用于 maxBufferedSize。
   * 支持传入 (value, key) 以便按 key 度量增量 buffer。
   * 默认：string 用 length，其余按 1。
   */
  estimateSize?: ((value: T, key: string) => number) | undefined;
};

/**
 * 通用批合并器：同 key 在 interval 内只 flush 一次（取合并后的最新值）。
 * flush 顺序 = Map 插入序（确定性）。
 */
export class StreamValueBatcher<T> {
  private pending = new Map<string, T>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 防止 onFlush 内 re-entrant flushNow / push→force 破坏快照 */
  private flushDepth = 0;
  /** 嵌套 flushNow 请求：外层结束后再刷一轮 */
  private flushAgain = false;
  private readonly intervalMs: number;
  private readonly setTimer: (
    fn: () => void,
    ms: number
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (id: ReturnType<typeof setTimeout>) => void;
  private readonly onFlush: StreamValueFlush<T>;
  private readonly merge?: ((prev: T, next: T) => T) | undefined;
  private readonly maxPendingKeys: number | null;
  private readonly maxBufferedSize: number | null;
  private readonly estimateSize: (value: T, key: string) => number;

  constructor(
    onFlush: StreamValueFlush<T>,
    options: StreamValueBatcherOptions<T> = {}
  ) {
    this.onFlush = onFlush;
    const rawInterval = options.intervalMs ?? 48;
    // 负值钳为 0（同步 flush 路径）；正数保持
    this.intervalMs = Number.isFinite(rawInterval)
      ? Math.max(0, rawInterval)
      : 48;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ??
      ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    this.merge = options.merge;
    this.maxPendingKeys =
      options.maxPendingKeys != null && options.maxPendingKeys > 0
        ? Math.floor(options.maxPendingKeys)
        : null;
    this.maxBufferedSize =
      options.maxBufferedSize != null && options.maxBufferedSize > 0
        ? Math.floor(options.maxBufferedSize)
        : 8000;
    this.estimateSize =
      options.estimateSize ??
      ((value: T) => (typeof value === 'string' ? value.length : 1));
  }

  /** 推入最新值；同 key 按 merge 合并（默认覆盖） */
  push(key: string, value: T): void {
    const prev = this.pending.get(key);
    const next =
      prev !== undefined && this.merge ? this.merge(prev, value) : value;
    this.pending.set(key, next);

    if (this.shouldForceFlush()) {
      this.flushNow();
      return;
    }

    // intervalMs === 0：不挂定时器，立即刷出（确定性同步路径）
    if (this.intervalMs === 0) {
      this.flushNow();
      return;
    }

    // flush 进行中：由 flush 收尾 schedule 或 flushAgain 处理，勿双重排程
    if (this.flushDepth > 0) return;
    if (this.timer != null) return;
    this.scheduleTimer();
  }

  /** 立即刷出全部待写（complete / stop / 终态事件） */
  flushNow(): void {
    this.clearScheduledTimer();
    if (this.flushDepth > 0) {
      // 嵌套调用：标记外层结束后再刷（含 onFlush 内 force / 显式 flushNow）
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

    // onFlush 期间 push 且未 force 的项：开启下一合并窗口
    if (this.pending.size > 0 && this.timer == null && this.intervalMs > 0) {
      this.scheduleTimer();
    } else if (this.pending.size > 0 && this.intervalMs === 0) {
      // 同步模式：继续刷到空（防 onFlush 再 push 死循环：仅一轮额外刷）
      this.flushDepth += 1;
      try {
        this.flushPendingOnce();
      } finally {
        this.flushDepth -= 1;
      }
    }
  }

  /** 丢弃某 key 的 pending（消息被撤回时）；pending 空则取消定时器 */
  drop(key: string): void {
    this.pending.delete(key);
    if (this.pending.size === 0) {
      this.clearScheduledTimer();
    }
  }

  /**
   * 取消/重置：丢弃全部 pending 并清定时器，不触发 onFlush。
   * 实例可继续 push 复用（与 dispose 同义，语义更明确）。
   */
  reset(): void {
    this.clearScheduledTimer();
    this.pending.clear();
    this.flushAgain = false;
  }

  /** 清空并取消定时器（不 flush）；等价于 reset，兼容历史 API */
  dispose(): void {
    this.reset();
  }

  /** 当前待刷条数（测试 / 诊断） */
  pendingCount(): number {
    return this.pending.size;
  }

  /** 是否仍有指定 key（或任意 key）待刷 */
  hasPending(key?: string): boolean {
    if (key === undefined) return this.pending.size > 0;
    return this.pending.has(key);
  }

  /** 是否已排程 interval 定时器 */
  isScheduled(): boolean {
    return this.timer != null;
  }

  /** 当前 pending 累计估算 size（诊断 / 测试） */
  bufferedSize(): number {
    let total = 0;
    for (const [key, value] of this.pending.entries()) {
      total += this.estimateSize(value, key);
    }
    return total;
  }

  private shouldForceFlush(): boolean {
    if (
      this.maxPendingKeys != null &&
      this.pending.size >= this.maxPendingKeys
    ) {
      return true;
    }
    if (
      this.maxBufferedSize != null &&
      this.bufferedSize() >= this.maxBufferedSize
    ) {
      return true;
    }
    return false;
  }

  private scheduleTimer(): void {
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flushNow();
    }, this.intervalMs);
  }

  private clearScheduledTimer(): void {
    if (this.timer != null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /**
   * 单轮快照 flush：先拷贝再 clear，onFlush 内 push 进入新 pending。
   * onFlush 抛错：当前失败项 + 其后未刷项回填；同 key 若已有更新则保留更新。
   */
  private flushPendingOnce(): void {
    if (this.pending.size === 0) return;
    const entries = [...this.pending.entries()];
    this.pending.clear();
    let i = 0;
    try {
      for (; i < entries.length; i++) {
        const [key, value] = entries[i]!;
        this.onFlush(key, value);
      }
    } catch (err) {
      for (let j = i; j < entries.length; j++) {
        const [key, value] = entries[j]!;
        // 同 key 若 flush 中途又被 push，保留更新后的 pending
        if (!this.pending.has(key)) this.pending.set(key, value);
      }
      throw err;
    }
  }
}

/**
 * Stage 02 默认单批次未排空增量字符上限（deltaChars = fullText.length - lastFlushedLength >= 120）。
 * 配合 48ms 节流窗口，既避免长文本（>8000 字）退化为每 token 同步强刷，又保证突发大 chunk 及时排空。
 */
export const DEFAULT_STREAM_MAX_DELTA_CHARS = 120;

export type StreamTextFlush = (key: string, text: string) => void;

export type StreamTextBatcherOptions = {
  /** 合并间隔（ms），默认 48 */
  intervalMs?: number;
  /** 定时器工厂（可测） */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
  /** pending key 数上限，触达则强制 flush */
  maxPendingKeys?: number;
  /**
   * 距离上次 flush 的未刷增量字符数上限（deltaChars = fullText.length - lastFlushedLength >= maxDeltaChars）。
   * 默认 DEFAULT_STREAM_MAX_DELTA_CHARS (120)。
   */
  maxDeltaChars?: number;
  /** maxDeltaChars 的同义配置项（兼容 Stage 01/02 详案命名） */
  maxBufferedDelta?: number;
  /**
   * 历史兼容命名：同样度量当前批次尚未刷新的增量字符数（而非全文累计长度），
   * 杜绝长文本跨过阈值后退化为每 token 同步强刷。
   */
  maxBufferedChars?: number;
};

/**
 * 流式正文/思考批合并：同 key 覆盖为最新全文（非 delta）。
 * 对外 API 与历史版本兼容，内部复用 StreamValueBatcher。
 *
 * 缓冲度量：严格度量距离上次 flush 的未刷增量字符数
 * `deltaChars = fullText.length - lastFlushedLength >= maxDeltaChars`（默认 120 字符），
 * 每次 flush 提交后 `lastFlushedLength` 推进至最新 `text.length`，增量计数器归零。
 */
export class StreamTextBatcher {
  private readonly inner: StreamValueBatcher<string>;
  private readonly committedLengths = new Map<string, number>();

  constructor(
    onFlush: StreamTextFlush,
    options: StreamTextBatcherOptions = {}
  ) {
    const resolvedMaxDelta =
      options.maxDeltaChars ??
      options.maxBufferedDelta ??
      options.maxBufferedChars ??
      DEFAULT_STREAM_MAX_DELTA_CHARS;

    this.inner = new StreamValueBatcher(
      (key, text) => {
        const prevCommitted = this.committedLengths.get(key);
        this.committedLengths.set(key, text.length);
        try {
          onFlush(key, text);
        } catch (err) {
          if (prevCommitted !== undefined) {
            this.committedLengths.set(key, prevCommitted);
          } else {
            this.committedLengths.delete(key);
          }
          throw err;
        }
      },
      {
        intervalMs: options.intervalMs,
        setTimer: options.setTimer,
        clearTimer: options.clearTimer,
        maxPendingKeys: options.maxPendingKeys,
        maxBufferedSize: resolvedMaxDelta,
        estimateSize: (text, key) => {
          const lastFlushedLength = this.committedLengths.get(key) ?? 0;
          return text.length >= lastFlushedLength
            ? text.length - lastFlushedLength
            : text.length;
        },
      }
    );
  }

  /** 推入最新全文（非 delta）；同 key 覆盖 */
  push(key: string, text: string): void {
    this.inner.push(key, text);
  }

  /** 立即刷出全部待写（complete / stop / unmount） */
  flushNow(): void {
    this.inner.flushNow();
  }

  /** 丢弃某 key 的 pending（消息被撤回时） */
  drop(key: string): void {
    this.committedLengths.delete(key);
    this.inner.drop(key);
  }

  /** 取消/重置：丢弃 pending，不 flush */
  reset(): void {
    this.committedLengths.clear();
    this.inner.reset();
  }

  /** 清空并取消定时器 */
  dispose(): void {
    this.committedLengths.clear();
    this.inner.dispose();
  }

  /** 当前待刷条数（测试用） */
  pendingCount(): number {
    return this.inner.pendingCount();
  }

  hasPending(key?: string): boolean {
    return this.inner.hasPending(key);
  }

  isScheduled(): boolean {
    return this.inner.isScheduled();
  }

  /** 当前 pending 文本增量字符数（未排空增量积压） */
  bufferedSize(): number {
    return this.inner.bufferedSize();
  }

  /** 读取指定 key 上次已 flush 提交的字符长度（lastFlushedLength） */
  getLastFlushedLength(key: string): number {
    return this.committedLengths.get(key) ?? 0;
  }

  /** 读取当前尚未 flush 的增量字符数（deltaChars） */
  getUnflushedDeltaChars(): number {
    return this.inner.bufferedSize();
  }
}

/**
 * 工具调用 patch：按 toolId 合并最新字段。
 * 与 MessageToolCall 结构对齐（id 必填，其余可选），避免 flush 侧字段漂移 / as any。
 */
export type StreamToolCallPatch = Pick<MessageToolCall, 'id'> &
  Partial<Omit<MessageToolCall, 'id'>>;

/** 同 toolId 合并：后者字段覆盖前者 */
export function mergeToolCallPatch(
  prev: StreamToolCallPatch,
  next: StreamToolCallPatch
): StreamToolCallPatch {
  return { ...prev, ...next, id: next.id || prev.id };
}

/**
 * 终态 / 需即时 UI 的工具状态：应 flushNow，避免审批/完成延迟一拍。
 * success / error / pending_approval 立即刷出；running 可批合并。
 */
export function isImmediateToolStatus(
  status: StreamToolCallPatch['status'] | undefined
): boolean {
  return (
    status === 'success' || status === 'error' || status === 'pending_approval'
  );
}

/** 会话 + 消息 id 合成 batch key */
export function streamBatchKey(sessionId: string, messageId: string): string {
  return `${sessionId}::${messageId}`;
}

/** 会话 + 消息 + 工具 id 合成 batch key */
export function streamToolBatchKey(
  sessionId: string,
  messageId: string,
  toolId: string
): string {
  return `${sessionId}::${messageId}::${toolId}`;
}

/** 解析工具 batch key；失败返回 null */
export function parseStreamToolBatchKey(
  key: string
): { sessionId: string; messageId: string; toolId: string } | null {
  const first = key.indexOf('::');
  const last = key.lastIndexOf('::');
  if (first < 0 || last <= first) return null;
  const sessionId = key.slice(0, first);
  const messageId = key.slice(first + 2, last);
  const toolId = key.slice(last + 2);
  if (!sessionId || !messageId || !toolId) return null;
  return { sessionId, messageId, toolId };
}
