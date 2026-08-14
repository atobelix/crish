/**
 * 流式渲染帧控制器：accumulate delta → rAF 分帧 flush。
 *
 * 与 StreamTextBatcher（定时批合并→store）不同，StreamRenderBuffer
 * 面向渲染管线最末端：控制每帧 payload 大小和执行耗时，避免长文本
 * 流式输出时单帧重计算/重布局卡顿。
 *
 * 设计：
 * - push(delta) 攒增量，start/stop 控制 rAF 开关
 * - flush 每帧最多处理 maxBytesPerFrame/6ms（120 FPS 适配），剩余排到下一帧
 * - reset 清空累计状态（切会话/新 run 时调用）
 * - isFinal=true 的帧不会再有后续 delta
 * - 统一单一时钟源与 Unicode Grapheme 簇边界截断（Intl.Segmenter）
 *
 * 字段演进：
 * - frame.html：预留 JS 增量解析器（IncrementalMarkdownParser）产出的 HTML；
 *   当前阶段解析器尚未接入，flush 暂写 ''，待解析器接入后由调用方在 onFrame
 *   之前填充。消费方应同时支持 '' 与非空字符串两条路径。
 * - frame.chunkUpdates：chunk 级 DOM 更新通道，当前不用，保留以备细粒度 patch。
 */

export interface RenderFrame {
  delta: string;
  full: string;
  lastOffset: number;
  isFinal: boolean;
  timestamp: number;
  /** JS 增量解析器产出的 HTML（流式期渲染用）；解析器接入前为 '' */
  html: string;
  /** chunk 级 DOM 更新（保留字段，当前不用） */
  chunkUpdates: never[];
  /** 当积压超过 maxBacklogBytes 且非 force 时为 true，表示跳帧降级 */
  degraded: boolean;
}

let segmenter: Intl.Segmenter | null = null;
function getGraphemeSegmenter(): Intl.Segmenter | null {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    if (!segmenter) {
      segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    }
    return segmenter;
  }
  return null;
}

export class StreamRenderBuffer {
  private pending: string[] = [];
  private fullText = '';
  private rafId: number | null = null;
  /** 最近一次 flush 时 fullText.length（用于 lastOffset） */
  private flushedLength = 0;
  /**
   * 单帧执行预算（ms）；默认 6ms — 120 FPS 适配。
   * 120 FPS 帧预算约 8.3ms，留 2.3ms 余量给 layout/paint 与 rAF 调度抖动。
   * 60 FPS 场景下也只占用约 36% 帧预算，仍能保持流畅交互。
   */
  private frameBudgetMs = 6;
  /** 单帧输出字符上限；默认 8192 */
  private maxBytesPerFrame = 8192;
  /** 积压降级阈值（字节）；超过此值时非 force flush 输出降级帧 */
  private maxBacklogBytes: number | undefined;
  /** 收到 final 标记后不再接收 push，仅 flush 剩余 */
  private finalMarked = false;
  /** 终态单次派发守卫：保证 isFinal 帧恰好派发一次 */
  private hasEmittedFinal = false;
  /**
   * S3 帧预算超限计数（渲染健康常驻指标）：非 force flush 单帧实际耗时
   * 超过 frameBudgetMs 的次数；不随渲染修复（G-03/B6）消失。
   */
  private frameOverrunCount = 0;

  onFrame: ((frame: RenderFrame) => void) | null = null;

  constructor(options?: {
    frameBudgetMs?: number;
    maxBytesPerFrame?: number;
    maxBacklogBytes?: number;
  }) {
    if (options?.frameBudgetMs != null && options.frameBudgetMs > 0) {
      this.frameBudgetMs = Math.max(1, Math.floor(options.frameBudgetMs));
    }
    if (options?.maxBytesPerFrame != null && options.maxBytesPerFrame > 0) {
      this.maxBytesPerFrame = Math.max(
        64,
        Math.floor(options.maxBytesPerFrame)
      );
    }
    if (options?.maxBacklogBytes != null && options.maxBacklogBytes > 0) {
      this.maxBacklogBytes = Math.floor(options.maxBacklogBytes);
    }
  }

  /**
   * 追加文本增量。
   * final=true 表示这是最后一块 delta（onComplete 路径），后续 push 不再接收。
   */
  push(delta: string, isFinal = false): void {
    if (this.finalMarked) return;
    if (!delta) {
      if (isFinal) {
        this.markFinal();
        // 若无残余，立即派发终态；若有残余，确保 rAF 调度激活
        if (this.pending.length > 0) {
          if (this.rafId == null) this.scheduleFlush();
        } else {
          this.flushFrame(true);
        }
      }
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

  /**
   * 预算式收口（08-detail 3.1，T2.1）：complete/stop 终态路径专用。
   *
   * - 残余 ≤ 2 × maxBytesPerFrame（≈16KB，常态）：同步 force 单帧刷完，
   *   帧成本有界（数毫秒级 setStreamText + 渲染），无长任务；
   * - 大残余（异常积压，如 100KB）：markFinal + 普通预算帧循环
   *   （每帧 ≤ maxBytesPerFrame），isFinal 仅出现在最后一帧——不再
   *   单帧全量 flush（R-01）。
   *
   * 与 flush(force) 的关系：flush(true) 语义保留（force 仍可用），但
   * complete/stop 路径不再调用它；本方法内部自行管理 final 标记，
   * 调用方无需再 push('', true)。
   */
  flushFinal(): void {
    this.cancelScheduledFlush();
    this.markFinal();
    if (this.bufferedLength() <= this.maxBytesPerFrame * 2) {
      // 常态：单帧同步刷完（force 有界，≤16KB）
      this.flushFrame(true);
    } else {
      // 大残余：预算分帧；flushFrame 内部对剩余 pending 继续 rAF 调度
      this.flushFrame(false);
    }
  }

  /** 重置累积缓冲区，清调度。切会话/新 run 时调用 */
  reset(): void {
    this.cancelScheduledFlush();
    this.pending = [];
    this.fullText = '';
    this.flushedLength = 0;
    this.finalMarked = false;
    this.hasEmittedFinal = false;
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

  /**
   * S3 帧预算超限计数读取（渲染健康常驻指标；条件告警在超限帧发出
   * console.warn——超阈值才告警，常态零日志）。
   */
  frameOverruns(): number {
    return this.frameOverrunCount;
  }

  // ── 内部 ──

  markFinal(): void {
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
      // 空残余终态补偿：处理 pending 为空但收到 isFinal 的时序
      if (this.finalMarked && !this.hasEmittedFinal) {
        this.hasEmittedFinal = true;
        this.onFrame?.({
          delta: '',
          full: this.fullText,
          lastOffset: this.flushedLength,
          isFinal: true,
          timestamp: performance.now(),
          html: '',
          chunkUpdates: [],
          degraded: false,
        });
      }
      return;
    }

    const frameStart = performance.now();
    const { batch, remaining } = flushFrame(
      this.pending,
      this.maxBytesPerFrame,
      frameStart + this.frameBudgetMs,
      force
    );
    const frameElapsed = performance.now() - frameStart;
    // S3 帧预算超限计数 + 条件告警（渲染健康常驻指标）：非 force 且单帧
    // 实际耗时超 frameBudgetMs 才计数并 warn——超阈值才告警，常态零日志。
    if (!force && frameElapsed > this.frameBudgetMs) {
      this.frameOverrunCount += 1;
      console.warn(
        `[StreamRenderBuffer] 帧预算超限：${frameElapsed.toFixed(1)}ms > ${this.frameBudgetMs}ms`
      );
    }
    this.pending = remaining;

    if (batch.length > 0) {
      const delta = batch.join('');
      this.fullText += delta;
      this.flushedLength = this.fullText.length;

      // 积压降级：非 force 且积压超过 maxBacklogBytes 时跳过渲染
      const degraded =
        !force &&
        this.maxBacklogBytes != null &&
        this.bufferedLength() > this.maxBacklogBytes;

      const isLastFrame = this.finalMarked && this.pending.length === 0;
      if (isLastFrame) {
        this.hasEmittedFinal = true;
      }

      const frame: RenderFrame = {
        delta,
        full: this.fullText,
        lastOffset: this.flushedLength,
        isFinal: isLastFrame,
        timestamp: performance.now(),
        html: '',
        chunkUpdates: [],
        degraded,
      };
      this.onFrame?.(frame);
    }

    // 还有剩余 pending + 非 final → 继续调度下一帧
    if (this.pending.length > 0) {
      this.scheduleFlush();
    }
  }
}

// ── 可测试的独立纯函数 ─────────────────────────────────────────────────────

/**
 * 在 UTF-16 代理对边界安全的位置截断字符串。
 * 保证不在高代理（0xD800–0xDBFF）和低代理（0xDC00–0xDFFF）之间截断。
 *
 * @param s     原字符串
 * @param maxLen 字节数（UTF-16 码元数）上限
 * @returns 安全截断位置（不超过 maxLen 的最大安全下标）
 */
export function safeUnicodeCutPosition(s: string, maxLen: number): number {
  if (maxLen <= 0) return 0;
  if (maxLen >= s.length) return s.length;
  // 若 maxLen 正好落在高代理上，回退一位
  const cp = s.charCodeAt(maxLen - 1);
  if (cp >= 0xd800 && cp <= 0xdbff) {
    return Math.max(0, maxLen - 1);
  }
  return maxLen;
}

/**
 * 在 Unicode Grapheme (字形簇) 边界安全的位置截断字符串。
 * 基于 Intl.Segmenter，保证不在 Emoji、ZWJ 序列、变音符号或代理对之间截断。
 *
 * @param s 原字符串
 * @param maxLen 字符数上限
 * @returns 不超过 maxLen 的最大安全字形簇下标
 */
export function safeGraphemeCutPosition(s: string, maxLen: number): number {
  if (maxLen <= 0) return 0;
  if (maxLen >= s.length) return s.length;

  const seg = getGraphemeSegmenter();
  if (seg) {
    let lastSafeIndex = 0;
    for (const { index } of seg.segment(s)) {
      if (index > maxLen) {
        return lastSafeIndex;
      }
      lastSafeIndex = index;
    }
    return lastSafeIndex;
  }

  // 降级：仅代理对检查
  return safeUnicodeCutPosition(s, maxLen);
}

/**
 * 单帧批处理的纯函数形式：从 pending 中提取本帧可处理的内容。
 *
 * @param pending       待处理的 delta 块数组（调用方 slice 传入）
 * @param maxBytes      单帧字节上限
 * @param deadlineMs    帧截止时间（performance.now() + budgetMs）
 * @param force         是否强制处理全部（忽略 maxBytes 和 deadline）
 * @returns {{ batch: string[]; remaining: string[] }} 本帧批次与剩余
 */
export function flushFrame(
  pending: readonly string[],
  maxBytes: number,
  deadlineMs: number,
  force: boolean
): { batch: string[]; remaining: string[] } {
  if (pending.length === 0) return { batch: [], remaining: [] };

  const batch: string[] = [];
  let bytesInBatch = 0;
  let splitAt = pending.length;

  for (let i = 0; i < pending.length; i++) {
    const chunk = pending[i]!;
    const wouldExceed = bytesInBatch + chunk.length > maxBytes;

    if (!force && wouldExceed) {
      if (batch.length > 0) {
        splitAt = i;
        break;
      }
      const budget = maxBytes - bytesInBatch;
      const cutPos = safeGraphemeCutPosition(chunk, budget);
      if (cutPos > 0 && cutPos < chunk.length) {
        batch.push(chunk.slice(0, cutPos));
        const remaining = [chunk.slice(cutPos), ...pending.slice(i + 1)];
        return { batch, remaining };
      } else if (cutPos === 0) {
        // 当单字符簇长度超过 budget 时，至少输出 1 个完整字形簇，避免永久阻塞
        const seg = getGraphemeSegmenter();
        let firstGraphemeLen = 0;
        if (seg) {
          for (const s of seg.segment(chunk)) {
            firstGraphemeLen = s.segment.length;
            break;
          }
        }
        if (firstGraphemeLen === 0) {
          firstGraphemeLen =
            chunk.length > 1 &&
            chunk.charCodeAt(0) >= 0xd800 &&
            chunk.charCodeAt(0) <= 0xdbff
              ? 2
              : 1;
        }
        batch.push(chunk.slice(0, firstGraphemeLen));
        const remaining = [
          chunk.slice(firstGraphemeLen),
          ...pending.slice(i + 1),
        ];
        return { batch, remaining };
      }
    }

    batch.push(chunk);
    bytesInBatch += chunk.length;

    if (!force && performance.now() >= deadlineMs) {
      splitAt = i + 1;
      break;
    }
  }

  return { batch, remaining: pending.slice(splitAt) as string[] };
}
