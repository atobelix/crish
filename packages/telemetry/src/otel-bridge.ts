/**
 * OpenTelemetry 桥接预留接口
 *
 * 仅定义接口，不实现，不引入 @opentelemetry/* 依赖。
 * 实现推迟到 Phase 2 / Round 10（Rust 侧 conex-telemetry crate 对齐）。
 *
 * 设计原则：
 * 1. OtelBridge 是回调接口，TraceManager 在 span 生命周期事件时调用
 * 2. OtelSpanExporter 是 OTel SDK 的抽象，未来由 @opentelemetry/sdk-trace-base 的 SpanExporter 实现
 * 3. OtelBridgeConfig 包含 OTel 资源属性（serviceName/serviceVersion）
 *
 * 详见 ROUND-02-infrastructure.md §7.4。
 */

import type { SpanEvent, TraceSpan } from './spans';

/**
 * Span 导出器抽象。
 *
 * 未来由 @opentelemetry/sdk-trace-base 的 SpanExporter 实现，
 * 或由 Rust 侧 IPC collector 适配器实现。
 */
export interface OtelSpanExporter {
  exportSpan(span: TraceSpan): void;
  flush(): Promise<void>;
}

/**
 * Span 生命周期回调桥接。
 *
 * TraceManager 在 startSpan / endSpan / addSpanEvent 时调用对应回调（若 bridge 已附加）。
 */
export interface OtelBridge {
  onStartSpan(span: TraceSpan): void;
  onEndSpan(span: TraceSpan): void;
  onSpanEvent(spanId: string, event: SpanEvent): void;
}

/**
 * OTel 桥接配置（资源属性）。
 */
export interface OtelBridgeConfig {
  exporter?: OtelSpanExporter | undefined;
  serviceName: string;
  serviceVersion?: string | undefined;
}
