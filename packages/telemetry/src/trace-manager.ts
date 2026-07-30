/**
 * TraceManager - 端到端追踪体系
 *
 * 从 agent-runtime/src/trace/index.ts 迁移，保持现有公共 API 不变。
 * 新增能力：
 * 1. setLogSink — 注入 Logger 日志 sink（addSpanEvent 时回调）
 * 2. attachOtelBridge — 注入 OpenTelemetry 桥接（span 生命周期回调）
 * 3. flushSync — 同步标记活跃 span 结束（CrashHandler 调用）
 *
 * 设计原则：
 * 1. TraceId 从用户操作到 UI 渲染全程传播
 * 2. 每个操作产生 Span，Span 之间有因果关系
 * 3. 追踪数据可查询、可分析
 * 4. 追踪开销最小化
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { BoundedMap, RingBuffer } from '@crish/shared-utils';

import type {
  LogSpanSink,
  SpanEvent,
  SpanStatus,
  TraceContext,
  TraceQuery,
  TraceQueryResult,
  TraceSpan,
} from './spans';
import type { OtelBridge } from './otel-bridge';

/**
 * 默认活跃 Span 容量上限。
 *
 * activeSpans 仅保存已启动但未结束的 Span。并发请求场景下 500 足够；
 * 超容量时 FIFO 淘汰最旧活跃 Span，被淘汰的 Span 后续 endSpan 将静默 no-op
 * （endSpan 已有 !span 提前返回分支）。
 */
export const DEFAULT_MAX_ACTIVE_SPANS = 500;

/**
 * 默认每个 Span 的事件容量上限。
 *
 * 用 RingBuffer 实现 O(1) 入队 + 自动覆盖最旧事件，避免数组 push 无界增长。
 */
export const DEFAULT_MAX_EVENTS_PER_SPAN = 100;

// ─── TraceManager ─────────────────────────────────────────

export class TraceManager {
  private traces: BoundedMap<string, TraceSpan[]>;
  private activeSpans: BoundedMap<string, TraceSpan>;
  private maxTraces: number;
  private maxSpansPerTrace: number;
  private maxActiveSpans: number;
  private maxEventsPerSpan: number;
  private _logSink: LogSpanSink | undefined;
  private _otelBridge: OtelBridge | undefined;

  constructor(options?: {
    maxTraces?: number;
    maxSpansPerTrace?: number;
    maxActiveSpans?: number;
    maxEventsPerSpan?: number;
  }) {
    this.maxTraces = options?.maxTraces ?? 1000;
    this.maxSpansPerTrace = options?.maxSpansPerTrace ?? 500;
    this.maxActiveSpans = options?.maxActiveSpans ?? DEFAULT_MAX_ACTIVE_SPANS;
    this.maxEventsPerSpan =
      options?.maxEventsPerSpan ?? DEFAULT_MAX_EVENTS_PER_SPAN;
    this.traces = new BoundedMap<string, TraceSpan[]>(
      this.maxTraces,
      undefined
    );
    this.activeSpans = new BoundedMap<string, TraceSpan>(
      this.maxActiveSpans,
      undefined
    );
  }

  /**
   * 创建新的 Trace
   */
  startTrace(
    name: string,
    sourceLayer: string,
    tags?: Record<string, string>
  ): TraceContext {
    const traceId = createTraceId();
    const spanId = createSpanId();

    const span: TraceSpan = {
      spanId,
      traceId,
      name,
      startedAt: Date.now(),
      status: 'ok',
      tags: tags ?? {},
      events: new RingBuffer<SpanEvent>(this.maxEventsPerSpan),
      sourceLayer,
    };

    this.activeSpans.set(spanId, span);
    this.traces.set(traceId, [span]);

    if (this._otelBridge) this._otelBridge.onStartSpan(span);

    return { traceId, spanId, sourceLayer };
  }

  /**
   * 在现有 Trace 中创建子 Span
   */
  startSpan(
    context: TraceContext,
    name: string,
    tags?: Record<string, string>
  ): TraceContext {
    const spanId = createSpanId();

    const span: TraceSpan = {
      spanId,
      traceId: context.traceId,
      parentSpanId: context.spanId,
      name,
      startedAt: Date.now(),
      status: 'ok',
      tags: tags ?? {},
      events: new RingBuffer<SpanEvent>(this.maxEventsPerSpan),
      sourceLayer: context.sourceLayer,
    };

    // 仅当 Span 能被记入其所属 Trace 时才纳入 activeSpans；否则该 Span 会成为
    // 孤儿（active 但不在任何 trace 中，永远无法被 query/getTraceChain 检索）。
    // 超容量时返回的 context 仍让调用方继续推进，但 addSpanEvent/endSpan 对其静默 no-op。
    const traceSpans = this.traces.get(context.traceId);
    if (traceSpans && traceSpans.length < this.maxSpansPerTrace) {
      traceSpans.push(span);
      this.activeSpans.set(spanId, span);
    }

    if (this._otelBridge) this._otelBridge.onStartSpan(span);

    return {
      traceId: context.traceId,
      spanId,
      parentSpanId: context.spanId,
      sourceLayer: context.sourceLayer,
    };
  }

  /**
   * 结束 Span
   */
  endSpan(spanId: string, status: SpanStatus = 'ok'): void {
    const span = this.activeSpans.get(spanId);
    if (!span) return;

    span.endedAt = Date.now();
    span.durationMs = span.endedAt - span.startedAt;
    span.status = status;

    this.activeSpans.delete(spanId);

    if (this._otelBridge) this._otelBridge.onEndSpan(span);
  }

  /**
   * 向 Span 添加事件
   *
   * 若已注入 logSink，则同时回调 sink（供 Logger 日志注入到 span 事件）。
   * 若已附加 otelBridge，则同步通知 bridge。
   */
  addSpanEvent(
    spanId: string,
    name: string,
    attributes?: Record<string, unknown>
  ): void {
    const span = this.activeSpans.get(spanId);
    if (!span) return;

    // RingBuffer.pushOverwritingOldest：O(1) 入队，超容量自动覆盖最旧事件
    const event: SpanEvent = {
      timestamp: Date.now(),
      name,
      ...(attributes !== undefined ? { attributes } : {}),
    };
    span.events.pushOverwritingOldest(event);

    if (this._otelBridge) this._otelBridge.onSpanEvent(spanId, event);

    if (this._logSink) {
      this._logSink.onLog({
        level: 'debug',
        msg: name,
        time: new Date().toISOString(),
        spanId,
        ...(attributes !== undefined ? attributes : {}),
      });
    }
  }

  /**
   * 向 Span 添加标签
   */
  addSpanTag(spanId: string, key: string, value: string): void {
    const span = this.activeSpans.get(spanId);
    if (!span) return;

    span.tags[key] = value;
  }

  /**
   * 查询追踪数据
   */
  query(query: TraceQuery): TraceQueryResult {
    let allSpans: TraceSpan[] = [];

    if (query.traceId) {
      allSpans = this.traces.get(query.traceId) ?? [];
    } else {
      for (const spans of this.traces.values()) {
        allSpans.push(...spans);
      }
    }

    // 过滤
    let filtered = allSpans.filter((span) => {
      if (query.spanName && span.name !== query.spanName) return false;
      if (query.sourceLayer && span.sourceLayer !== query.sourceLayer)
        return false;
      if (query.status && span.status !== query.status) return false;
      if (query.minDurationMs && (span.durationMs ?? 0) < query.minDurationMs)
        return false;
      if (query.startedAfter && span.startedAt < query.startedAfter)
        return false;
      if (query.startedBefore && span.startedAt > query.startedBefore)
        return false;
      if (query.tags) {
        for (const [key, value] of Object.entries(query.tags)) {
          if (span.tags[key] !== value) return false;
        }
      }
      return true;
    });

    const totalMatches = filtered.length;

    // 按层统计
    const layerBreakdown: Record<string, number> = {};
    for (const span of filtered) {
      layerBreakdown[span.sourceLayer] =
        (layerBreakdown[span.sourceLayer] ?? 0) + 1;
    }

    // 最慢的 Span
    const slowestSpans = [...filtered]
      .filter((s) => s.durationMs !== undefined)
      .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
      .slice(0, 10);

    // 限制返回数量
    if (query.limit) {
      filtered = filtered.slice(0, query.limit);
    }

    return {
      spans: filtered,
      totalMatches,
      layerBreakdown,
      slowestSpans,
    };
  }

  /**
   * 获取完整的 Trace 链
   */
  getTraceChain(traceId: string): TraceSpan[] {
    return this.traces.get(traceId) ?? [];
  }

  /**
   * 获取活跃 Span 数量
   */
  getActiveSpanCount(): number {
    return this.activeSpans.size;
  }

  /**
   * 获取 Trace 数量
   */
  getTraceCount(): number {
    return this.traces.size;
  }

  /**
   * 清理旧的 Trace
   *
   * traces 已由 BoundedMap 在容量上限自动按 FIFO 淘汰，此处仅做按龄清理。
   * 先收集待删除 key 再统一 delete，避免迭代中修改 BoundedMap 内部 insertionOrder。
   */
  cleanup(maxAge: number): number {
    const cutoff = Date.now() - maxAge;
    let cleaned = 0;
    const stale: string[] = [];

    for (const [traceId, spans] of this.traces) {
      const allEnded = spans.every((s) => s.endedAt !== undefined);
      const oldestStart = Math.min(...spans.map((s) => s.startedAt));

      if (allEnded && oldestStart < cutoff) {
        stale.push(traceId);
      }
    }

    for (const traceId of stale) {
      this.traces.delete(traceId);
      cleaned++;
    }

    return cleaned;
  }

  /**
   * 注入 Logger 日志 sink。
   *
   * 之后每次 addSpanEvent 会回调 sink.onLog，将 span 事件作为日志条目转发给 Logger。
   * 接线方式（由 agent-core Round 5 完成）：
   *   traceManager.setLogSink(logger.getSpanSink())
   */
  setLogSink(sink: LogSpanSink | undefined): void {
    this._logSink = sink;
  }

  /**
   * 附加 OpenTelemetry 桥接。
   *
   * 之后 startSpan / endSpan / addSpanEvent 会同步通知 bridge。
   * 实现推迟到 Phase 2 / Round 10。
   */
  attachOtelBridge(bridge: OtelBridge | undefined): void {
    this._otelBridge = bridge;
  }

  /**
   * 同步标记活跃 span 结束（crash 时尽力保存 span 状态）。
   *
   * 由 CrashHandler 在 uncaughtException / unhandledRejection 时调用。
   * 将所有未结束的活跃 span 标记为 error 状态并填充 endedAt / durationMs。
   */
  flushSync(): void {
    const now = Date.now();
    for (const span of this.activeSpans.values()) {
      if (span.endedAt === undefined) {
        span.endedAt = now;
        span.durationMs = now - span.startedAt;
        span.status = 'error';
      }
    }
  }
}

// ─── 全局 Trace 上下文传播 ────────────────────────────────

/**
 * 基于 AsyncLocalStorage 的 Trace 上下文传播
 *
 * 使用 ALS 确保异步操作间的上下文隔离，
 * 避免并发请求之间的 TraceId 串扰。
 */
const traceContextStorage = new AsyncLocalStorage<TraceContext>();

/**
 * 已废弃：请使用 withTraceContext(context, () => { ... }) 替代。
 *
 * 直接调用 traceContextStorage.run(context, () => {}) 无法让上下文
 * 跨越当前同步调用栈传播，仅 withTraceContext 包裹的回调能正确读取。
 */
export function setTraceContext(context: TraceContext | undefined): void {
  if (context) {
    traceContextStorage.run(context, () => {});
  }
}

export function getTraceContext(): TraceContext | undefined {
  return traceContextStorage.getStore();
}

export function withTraceContext<T>(context: TraceContext, fn: () => T): T {
  return traceContextStorage.run(context, fn);
}

// ─── 工具函数 ─────────────────────────────────────────────

export function createTraceId(): string {
  return `trace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createSpanId(): string {
  return `span-${Math.random().toString(36).slice(2, 10)}`;
}
