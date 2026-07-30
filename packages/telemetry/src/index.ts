/**
 * @crish/telemetry
 *
 * Span / Trace / OTel 桥接可观测性栈（Layer 1 leaf）。
 *
 * 依赖：@crish/shared-types、@crish/shared-utils（BoundedMap / RingBuffer）。
 * 不依赖 @crish/logger（LogSpanSink 接口结构兼容，由 agent-core Round 5 接线）。
 */

// Span / Trace 核心类型
export type {
  SpanStatus,
  SpanEvent,
  TraceSpan,
  TraceContext,
  TraceQuery,
  TraceQueryResult,
  LogSpanSink,
} from './spans';

// TraceManager + 全局上下文传播 + 工具函数
export {
  TraceManager,
  setTraceContext,
  getTraceContext,
  withTraceContext,
  createTraceId,
  createSpanId,
  DEFAULT_MAX_ACTIVE_SPANS,
  DEFAULT_MAX_EVENTS_PER_SPAN,
} from './trace-manager';

// OTel 桥接预留接口（仅定义，不实现）
export type {
  OtelSpanExporter,
  OtelBridge,
  OtelBridgeConfig,
} from './otel-bridge';

// CrashHandler — 进程崩溃时的最后一搏日志持久化
export { CrashHandler } from './crash-handler';
export type { CrashHandlerOptions } from './crash-handler';
