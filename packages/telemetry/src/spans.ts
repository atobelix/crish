/**
 * Span / Trace 核心类型定义
 *
 * 从 agent-runtime/src/trace/index.ts 迁移，保持字段不变。
 * 新增 SpanStatus 类型别名与 LogSpanSink 接口（与 @crish/logger 结构兼容）。
 *
 * 设计原则：
 * 1. TraceSpan.events 保持 RingBuffer<SpanEvent> 类型（O(1) 入队 + 自动覆盖最旧事件）
 * 2. SpanStatus 提取为独立类型别名，供 endSpan 参数与 TraceQuery.status 使用
 * 3. LogSpanSink 接口比 @crish/logger 的 LogSpanSink 更宽泛（鸭子类型兼容）
 */

import type { RingBuffer } from '@crish/shared-utils';

// ─── Span 状态 ───────────────────────────────────────────

export type SpanStatus = 'ok' | 'error' | 'timeout';

// ─── Span 事件 ───────────────────────────────────────────

export interface SpanEvent {
  timestamp: number;
  name: string;
  attributes?: Record<string, unknown> | undefined;
}

// ─── TraceSpan ───────────────────────────────────────────

export interface TraceSpan {
  /** Span ID */
  spanId: string;
  /** 所属 Trace */
  traceId: string;
  /** 父 Span ID */
  parentSpanId?: string | undefined;
  /** Span 名称 */
  name: string;
  /** 开始时间 */
  startedAt: number;
  /** 结束时间 */
  endedAt?: number | undefined;
  /** 持续时间（ms） */
  durationMs?: number | undefined;
  /** Span 状态 */
  status: SpanStatus;
  /** 标签 */
  tags: Record<string, string>;
  /** 事件日志（有界 RingBuffer，超容量自动覆盖最旧事件） */
  events: RingBuffer<SpanEvent>;
  /** 来源层 */
  sourceLayer: string;
}

// ─── 追踪上下文 ───────────────────────────────────────────

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string | undefined;
  sourceLayer: string;
}

// ─── 追踪查询 ─────────────────────────────────────────────

export interface TraceQuery {
  traceId?: string | undefined;
  spanName?: string | undefined;
  sourceLayer?: string | undefined;
  status?: SpanStatus | undefined;
  minDurationMs?: number | undefined;
  startedAfter?: number | undefined;
  startedBefore?: number | undefined;
  tags?: Record<string, string> | undefined;
  limit?: number | undefined;
}

export interface TraceQueryResult {
  spans: TraceSpan[];
  totalMatches: number;
  /** 按层统计 */
  layerBreakdown: Record<string, number>;
  /** 最慢的 Span */
  slowestSpans: TraceSpan[];
}

// ─── LogSpanSink（与 @crish/logger 结构兼容） ────────────

/**
 * Logger 日志注入 Telemetry span 事件的 sink 接口。
 *
 * 与 @crish/logger 的 LogSpanSink 结构兼容（鸭子类型）：
 * - @crish/logger 的 LogSpanSink.onLog 接受完整 LogEntry（含 level/time/msg 等）
 * - @crish/telemetry 的 LogSpanSink.onLog 接受任何带 level/msg/time 的对象
 *
 * 由于 LogEntry 满足此接口的结构要求，Logger 的 _spanSink 可接受 Telemetry 的实现，
 * 反之亦然。接线由 agent-core（Round 5）完成：
 *   traceManager.setLogSink(logger.getSpanSink())
 */
export interface LogSpanSink {
  onLog(entry: {
    level: string;
    msg: string;
    time: string;
    [key: string]: unknown;
  }): void;
}
