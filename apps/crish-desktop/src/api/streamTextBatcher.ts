/**
 * 流式正文批合并：processing 期间将高频 text 更新合并为短间隔一次 flush，
 * 降低 store/UI 提交频率；complete/cancel 时必须 flushNow 保证终态不丢。
 */

export type StreamTextFlush = (key: string, text: string) => void;

export type StreamTextBatcherOptions = {
  /** 合并间隔（ms），默认 48 */
  intervalMs?: number;
  /** 定时器工厂（可测） */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
};

export class StreamTextBatcher {
  private pending = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly intervalMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (id: ReturnType<typeof setTimeout>) => void;
  private readonly onFlush: StreamTextFlush;

  constructor(onFlush: StreamTextFlush, options: StreamTextBatcherOptions = {}) {
    this.onFlush = onFlush;
    this.intervalMs = options.intervalMs ?? 48;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  }

  /** 推入最新全文（非 delta）；同 key 覆盖 */
  push(key: string, text: string): void {
    this.pending.set(key, text);
    if (this.timer != null) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flushPending();
    }, this.intervalMs);
  }

  /** 立即刷出全部待写（complete / stop / unmount） */
  flushNow(): void {
    if (this.timer != null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.flushPending();
  }

  /** 丢弃某 key 的 pending（消息被撤回时） */
  drop(key: string): void {
    this.pending.delete(key);
  }

  /** 清空并取消定时器 */
  dispose(): void {
    if (this.timer != null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.pending.clear();
  }

  /** 当前待刷条数（测试用） */
  pendingCount(): number {
    return this.pending.size;
  }

  private flushPending(): void {
    if (this.pending.size === 0) return;
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [key, text] of entries) {
      this.onFlush(key, text);
    }
  }
}

/** 会话 + 消息 id 合成 batch key */
export function streamBatchKey(sessionId: string, messageId: string): string {
  return `${sessionId}::${messageId}`;
}
