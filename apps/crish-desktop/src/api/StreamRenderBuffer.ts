/**
 * 流式渲染帧控制器：accumulate delta → rAF 分帧 flush。
 *
 * 与 StreamTextBatcher（定时批合并→store）不同，StreamRenderBuffer
 * 面向渲染管线最末端：控制每帧 payload 大小和执行耗时，避免长文本
 * 流式输出时单帧重计算/重布局卡顿。
 *
 * 设计：
 * - push(delta) 攒增量，start/stop 控制 rAF 开关
 * - flush 每帧最多处理 maxBytesPerFrame/12ms，剩余排到下一帧
 * - reset 清空累计状态（切会话/新 run 时调用）
 * - isFinal=true 的帧不会再有后续 delta
 */

import { IncrementalMarkdownBridge } from './incrementalMarkdownBridge';
import type { ChunkUpdate } from './IncrementalMarkdownParser';

export interface RenderFrame {
  delta: string;
  full: string;
  lastOffset: number;
  isFinal: boolean;
  timestamp: number;
  html: string;
  chunkUpdates: ChunkUpdate[];
}

export class StreamRenderBuffer {
  private pending: string[] = [];
  private fullText = '';
  private rafId: number | null = null;
  /** 最近一次 flush 时 fullText.length（用于 lastOffset） */
  private flushedLength = 0;
  /** 单帧执行预算（ms）；默认 12ms — 让出主线程给 layout/paint */
  private frameBudgetMs = 12;
  /** 单帧输出字符上限；默认 8192 */
  private maxBytesPerFrame = 8192;
  /** 收到 final 标记后不再接收 push，仅 flush 剩余 */
  private finalMarked = false;
  /** 增量 markdown 渲染桥接 */
  private bridge = new IncrementalMarkdownBridge();

  onFrame: ((frame: RenderFrame) => void) | null = null;

  constructor(
    options?: { frameBudgetMs?: number; maxBytesPerFrame?: number },
  ) {
    if (options?.frameBudgetMs != null && options.frameBudgetMs > 0) {
      this.frameBudgetMs = Math.max(1, Math.floor(options.frameBudgetMs));
    }
    if (options?.maxBytesPerFrame != null && options.maxBytesPerFrame > 0) {
      this.maxBytesPerFrame = Math.max(64, Math.floor(options.maxBytesPerFrame));
    }
  }

  /**
   * 追加文本增量。
   * final=true 表示这是最后一块 delta（onComplete 路径），后续 push 不再接收。
   */
  push(delta: string, isFinal = false): void {
    if (this.finalMarked) return;
    if (!delta) {
      if (isFinal) this.markFinal();
      return;
    }
    this.pending.push(delta);
    if (isFinal) this.markFinal();
    if (this.rafId == null) {
      this.scheduleFlush();
    }
  }

  /**
   * 手动刷帧。
   * @param force true = 无视 budget 一次性刷完（complete/stop 终态路径）
   */
  flush(force = false): void {
    this.cancelScheduledFlush();
    this.flushFrame(force);
    // force 时若仍有残余（极特殊情况），再调度一帧
    if (this.pending.length > 0) {
      this.scheduleFlush();
    }
  }

  /** 重置累积缓冲区，清调度。切会话/新 run 时调用 */
  reset(): void {
    this.cancelScheduledFlush();
    this.pending = [];
    this.fullText = '';
    this.flushedLength = 0;
    this.finalMarked = false;
    this.bridge.reset();
  }

  /** 启动 rAF 调度（reset 后重新开始接收 delta） */
  start(): void {
    if (this.rafId != null) return;
    if (this.pending.length > 0) {
      this.scheduleFlush();
    }
  }

  /** 停止 rAF 调度（不 reset 缓冲区，可 resume） */
  stop(): void {
    this.cancelScheduledFlush();
  }

  /** pending 字符总数 */
  bufferedLength(): number {
    let total = 0;
    for (const chunk of this.pending) {
      total += chunk.length;
    }
    return total;
  }

  /** 当前完整文本（已刷 + pending） */
  currentText(): string {
    return this.fullText + this.pending.join('');
  }

  // ── 内部 ──

  private markFinal(): void {
    this.finalMarked = true;
  }

  private scheduleFlush(): void {
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.flushFrame(false);
    });
  }

  private cancelScheduledFlush(): void {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * 单帧 flush：在 budget 内拼接 delta 并回调。
   * force 时无视 maxBytesPerFrame/frameBudgetMs 全部输出。
   */
  private flushFrame(force: boolean): void {
    if (this.pending.length === 0) {
      // 无数据时不做任何事 — push() 会在新 delta 到达时启动 rAF
      return;
    }

    const batch: string[] = [];
    let bytesInBatch = 0;
    const deadline = performance.now() + this.frameBudgetMs;

    for (let i = 0; i < this.pending.length; i++) {
      const chunk = this.pending[i]!;
      const wouldExceed = bytesInBatch + chunk.length > this.maxBytesPerFrame;

      if (!force && wouldExceed && batch.length > 0) {
        // 已攒了一批且超上限：剩余留到下一帧
        this.pending = this.pending.slice(i);
        break;
      }

      batch.push(chunk);
      bytesInBatch += chunk.length;

      if (!force && performance.now() >= deadline) {
        this.pending = this.pending.slice(i + 1);
        break;
      }

      // force 模式下取全部
      if (force && i === this.pending.length - 1) {
        this.pending = [];
      }
    }

    if (batch.length === 0) {
      // 单块超 maxBytesPerFrame：拆分成多帧
      if (this.pending.length > 0) {
        const chunk = this.pending.shift()!;
        if (chunk.length > this.maxBytesPerFrame) {
          for (let offset = 0; offset < chunk.length; offset += this.maxBytesPerFrame) {
            const end = offset + this.maxBytesPerFrame;
            batch.push(chunk.slice(offset, end));
            bytesInBatch += end - offset;
          }
        } else {
          batch.push(chunk);
          bytesInBatch = chunk.length;
        }
      }
    }

    if (batch.length > 0) {
      const delta = batch.join('');
      this.fullText += delta;
      this.flushedLength = this.fullText.length;

      const { html, updates } = this.bridge.push(this.fullText);

      const frame: RenderFrame = {
        delta,
        full: this.fullText,
        lastOffset: this.flushedLength,
        isFinal: this.finalMarked && this.pending.length === 0,
        timestamp: performance.now(),
        html,
        chunkUpdates: updates,
      };
      this.onFrame?.(frame);
    }

    // 还有剩余 pending + 非 final → 继续调度下一帧
    if (this.pending.length > 0) {
      this.scheduleFlush();
    }
  }
}
