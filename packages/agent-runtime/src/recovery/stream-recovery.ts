/**
 * 流中断恢复系统。
 *
 * 支持三种恢复策略：
 *   1. HTTP Range 重连 — 服务端支持 range 请求时，只请求丢失的部分
 *   2. 全量重试 + 去重 — 不依赖服务端支持，客户端去重
 *   3. 工具执行幂等性 — 确保重连后不会重复执行工具
 */

import type { ProviderStreamContractEvent } from '../provider-stream-contract';

// ─── 重连光标 ─────────────────────────────────────────────

export interface StreamRecoveryCursor {
  /** 已确认收到的事件序列号 */
  lastConfirmedSequence: number;
  /** 最后收到的事件 ID（如 OpenAI 的 event_id） */
  lastEventId?: string;
  /** 已产出的 tool-call IDs（用于去重） */
  emittedToolCallIds: string[];
  /** 已收到的 bytes 数 */
  receivedBytes: number;
  /** 已收到的帧数 */
  receivedFrames: number;
}

export interface StreamRecoveryOptions {
  /** 是否启用 HTTP Range 重连 */
  enableRangeRecovery: boolean;
  /** 是否启用全量重试 */
  enableFullRetry: boolean;
  /** 最大重试次数 */
  maxRetries: number;
  /** 重试延迟基数（ms） */
  baseRetryDelayMs: number;
  /** 最大重试延迟（ms） */
  maxRetryDelayMs: number;
}

const DEFAULT_OPTIONS: StreamRecoveryOptions = {
  enableRangeRecovery: true,
  enableFullRetry: true,
  maxRetries: 3,
  baseRetryDelayMs: 1000,
  maxRetryDelayMs: 15000,
};

export class StreamRecoveryManager {
  private options: StreamRecoveryOptions;
  private cursor: StreamRecoveryCursor = this.emptyCursor();
  private retryCount = 0;

  constructor(options?: Partial<StreamRecoveryOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  getCursor(): StreamRecoveryCursor {
    return { ...this.cursor };
  }

  updateCursor(event: ProviderStreamContractEvent): void {
    this.cursor.lastConfirmedSequence = event.sequence;

    if (
      event.type === 'tool-call' &&
      event.phase === 'end' &&
      event.toolCall.id
    ) {
      if (!this.cursor.emittedToolCallIds.includes(event.toolCall.id)) {
        this.cursor.emittedToolCallIds.push(event.toolCall.id);
      }
    }
  }

  /**
   * 决定重试策略。
   * 返回 { action: 'retry' | 'abort', delay?: number, range?: { start: number } }
   */
  decideRetry(
    error: { status?: number; message: string },
    headers?: Record<string, string>
  ): StreamRetryDecision {
    if (this.retryCount >= this.options.maxRetries) {
      return { action: 'abort', reason: 'Max retries exceeded' };
    }

    this.retryCount++;

    // HTTP 429 (rate limit): 用 Retry-After
    if (error.status === 429) {
      const retryAfter = parseRetryAfter(headers?.['retry-after']);
      return {
        action: 'retry',
        delay: retryAfter ?? this.backoffDelay(),
        reason: 'rate-limit',
      };
    }

    // HTTP 5xx: 服务端错误
    if (error.status && error.status >= 500 && error.status < 600) {
      return {
        action: 'retry',
        delay: this.backoffDelay(),
        reason: 'server-error',
      };
    }

    // 网络错误
    if (isNetworkError(error.message)) {
      const usesRange =
        this.options.enableRangeRecovery && this.cursor.receivedBytes > 0;
      return {
        action: 'retry',
        delay: this.backoffDelay(),
        reason: 'network',
        ...(usesRange ? { range: { start: this.cursor.receivedBytes } } : {}),
      };
    }

    // 流中断（连接断开但已有部分数据）
    if (isStreamInterruption(error.message)) {
      return {
        action: 'retry',
        delay: this.backoffDelay(),
        reason: 'stream-interrupted',
      };
    }

    return { action: 'abort', reason: `Non-retryable error: ${error.message}` };
  }

  /**
   * 对已产出的事件去重（基于 event_id 或 sequence）。
   */
  deduplicate(
    events: ProviderStreamContractEvent[]
  ): ProviderStreamContractEvent[] {
    const seenSequences = new Set<number>();
    const seenToolCallIds = new Set<string>(this.cursor.emittedToolCallIds);

    return events.filter((event) => {
      // 按 sequence 去重
      if (seenSequences.has(event.sequence)) return false;
      seenSequences.add(event.sequence);

      // 对 tool-call end 事件去重
      if (
        event.type === 'tool-call' &&
        event.phase === 'end' &&
        event.toolCall.id
      ) {
        if (seenToolCallIds.has(event.toolCall.id)) return false;
        seenToolCallIds.add(event.toolCall.id);
      }

      return true;
    });
  }

  /**
   * 重置重连状态（开始新的流时调用）。
   */
  reset(): void {
    this.cursor = this.emptyCursor();
    this.retryCount = 0;
  }

  private emptyCursor(): StreamRecoveryCursor {
    return {
      lastConfirmedSequence: 0,
      emittedToolCallIds: [],
      receivedBytes: 0,
      receivedFrames: 0,
    };
  }

  private backoffDelay(): number {
    const delay = Math.min(
      this.options.baseRetryDelayMs * Math.pow(2, this.retryCount - 1),
      this.options.maxRetryDelayMs
    );
    // 加入 jitter
    return delay * (0.5 + Math.random() * 0.5);
  }
}

export interface StreamRetryDecision {
  action: 'retry' | 'abort';
  delay?: number;
  reason: string;
  range?: { start: number };
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = parseInt(value, 10);
  if (!isNaN(seconds) && seconds >= 0) return seconds * 1000;
  return undefined;
}

function isNetworkError(message: string): boolean {
  const patterns = [
    /network/i,
    /econnreset/i,
    /enotfound/i,
    /econnrefused/i,
    /socket/i,
    /tls/i,
    /fetch failed/i,
    /timeout/i,
    /abort/i,
  ];
  return patterns.some((p) => p.test(message));
}

function isStreamInterruption(message: string): boolean {
  const patterns = [
    /stream.*interrupt/i,
    /connection.*close/i,
    /premature.*close/i,
    /unexpected.*end/i,
    /chunk.*error/i,
  ];
  return patterns.some((p) => p.test(message));
}

// ─── 工具幂等性守卫 ─────────────────────────────────────

/**
 * 工具执行幂等性守卫。
 *
 * 记录已执行的 tool-call IDs，防止重连后重复执行。
 */
export class ToolIdempotencyGuard {
  private executedIds = new Set<string>();

  /**
   * 检查工具调用是否应该执行。
   * 返回 true 表示首次看到此 ID，可以执行。
   */
  shouldExecute(toolCallId: string): boolean {
    if (this.executedIds.has(toolCallId)) return false;
    this.executedIds.add(toolCallId);
    return true;
  }

  /**
   * 批量注册已执行过的 ID（从持久化状态恢复时）。
   */
  restore(ids: string[]): void {
    for (const id of ids) {
      this.executedIds.add(id);
    }
  }

  snapshot(): string[] {
    return [...this.executedIds];
  }
}
