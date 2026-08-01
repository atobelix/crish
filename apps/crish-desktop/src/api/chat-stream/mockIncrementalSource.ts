/**
 * T02.1 契约形状的 mock 增量源（测试 / 演示用）。
 *
 * 契约 SoT：docs/rust-rewrite/plans/PE-02-streaming-markdown-plan.md §3.1
 * 事件形状与 T02.1 契约对齐（禁止跨帧/跨块聚合后一次性 emit）：
 *   - text_delta / thought_delta 逐事件产出（真实实现归 PE-09，ProviderEventStream）
 *   - 每流恰好一个 stop，stop 之后无事件
 *   - 前端协议零改动：message-delta 增量 + message-end 全文（EventRouter 已按
 *     assistantText += t 累加消费）
 *
 * 用法：
 *   1. 测试：const src = new MockIncrementalSource(fullText, { chunkSize: 8 });
 *      while ((ev = src.next())) … 逐事件喂给 AsyncMarkdownBlock 的 push。
 *   2. 演示：src.start(onDelta, onDone) 按 delayMs 定时逐事件 emit，返回取消函数。
 *
 * 注意：本文件是 T02.1 前端 mock 资产，联调（T02.6）完成后保留为测试资产，
 * 生产增量流仍以 PE-09 的真实 Rust 实现为准。
 */

export type MockDeltaEvent =
  | { kind: 'text_delta'; text: string }
  | { kind: 'thought_delta'; text: string }
  | { kind: 'stop'; reason?: string };

export interface MockIncrementalSourceOptions {
  /** 每次 emit 的增量大小（UTF-16 码元数）；默认 4 */
  chunkSize?: number;
  /** 相邻事件间隔 ms（演示用）；默认 0（测试用同步序列） */
  delayMs?: number;
}

/** 把全文切成契约形状的 delta 事件序列（不含 stop） */
export function splitTextDeltas(
  fullText: string,
  chunkSize = 4
): MockDeltaEvent[] {
  const size = Math.max(1, Math.floor(chunkSize));
  const events: MockDeltaEvent[] = [];
  for (let i = 0; i < fullText.length; i += size) {
    events.push({ kind: 'text_delta', text: fullText.slice(i, i + size) });
  }
  return events;
}

export class MockIncrementalSource {
  private readonly deltas: MockDeltaEvent[];
  private readonly delayMs: number;
  private index = 0;
  private timer: number | null = null;
  private started = false;

  constructor(
    fullText: string,
    options?: MockIncrementalSourceOptions
  ) {
    this.deltas = splitTextDeltas(
      fullText,
      options?.chunkSize
    );
    this.deltas.push({ kind: 'stop' });
    this.delayMs = Math.max(0, options?.delayMs ?? 0);
  }

  /** 同步逐事件取用（测试路径）；耗尽返回 null */
  next(): MockDeltaEvent | null {
    if (this.index >= this.deltas.length) return null;
    const ev = this.deltas[this.index]!;
    this.index += 1;
    return ev;
  }

  /** 异步定时 emit（演示 / 联调路径）；返回取消函数 */
  start(
    onDelta: (ev: MockDeltaEvent) => void,
    onDone?: () => void
  ): () => void {
    if (this.started) {
      throw new Error('MockIncrementalSource 已启动，禁止重复 start');
    }
    this.started = true;
    const pump = () => {
      this.timer = null;
      const ev = this.next();
      if (!ev) {
        onDone?.();
        return;
      }
      onDelta(ev);
      this.timer = window.setTimeout(pump, this.delayMs);
    };
    pump();
    return () => {
      if (this.timer != null) {
        window.clearTimeout(this.timer);
        this.timer = null;
      }
    };
  }

  get remaining(): number {
    return this.deltas.length - this.index;
  }
}
