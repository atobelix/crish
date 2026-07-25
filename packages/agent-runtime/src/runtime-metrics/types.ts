import type { JsonObject } from "@crish/shared-types";
import type { BoundedMap } from "@crish/shared-utils";
import type { PromptAssemblyMetadata } from "../prompt-assembly";

export interface RuntimeMetricsDimensions {
  providerFamily?: string;
  providerId?: string;
  modelFamily?: string;
  configuredModel?: string;
  actualModel?: string;
  cacheStrategy?: string;
  stablePrefixHash?: string;
  toolSchemaHash?: string;
  cacheKey?: string;
}

export interface RuntimeProviderUsageMetrics {
  sampleCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface RuntimeCacheMetricsSnapshot {
  sampleCount: number;
  promptTokens: number;
  readTokens: number;
  writeTokens: number;
  missTokens: number;
  hitRatio: number;
  writeRatio: number;
}

export interface RuntimeDurationMetrics {
  count: number;
  min?: number;
  max?: number;
  p50?: number;
  p95?: number;
  p99?: number;
}

export interface RuntimeToolNameMetricsSnapshot {
  toolName: string;
  callCount: number;
  errorCount: number;
  errorRate: number;
  timeoutCount: number;
  timeoutRate: number;
  cancelCount: number;
  cancelRate: number;
  durationMs: RuntimeDurationMetrics;
  avgDurationMs: number;
  p95DurationMs: number;
  successRate: number;
  byteSizeTotal: number;
  byteSizeAvg: number;
}

export interface RuntimeToolMetricsSnapshot {
  callCount: number;
  errorCount: number;
  errorRate: number;
  timeoutCount: number;
  timeoutRate: number;
  cancelCount: number;
  cancelRate: number;
  durationMs: RuntimeDurationMetrics;
  byName: Record<string, RuntimeToolNameMetricsSnapshot>;
}

export interface RuntimeFailureMetricsSnapshot {
  errorCount: number;
  runtimeErrorCount: number;
  agentErrorCount: number;
  providerErrorCount: number;
  contextCompressionErrorCount: number;
  timeoutCount: number;
  cancelCount: number;
}

export interface RuntimePayloadSummary {
  kind: "json";
  byteSize: number;
  sha256: string;
  redacted: true;
  keys?: string[];
}

export type RuntimeSpanKind =
  | "conversation"
  | "run"
  | "message"
  | "model-stream"
  | "tool-call"
  | "shell-command"
  | "sidecar-query"
  | "daemon-ws-send"
  | "event-replay"
  | "checkpoint"
  | "rewind";

export type RuntimeSpanStatus = "ok" | "error" | "cancelled" | "timeout" | "in-progress";

export type RuntimeErrorLayer =
  | "runtime"
  | "agent"
  | "provider"
  | "tool"
  | "sidecar"
  | "daemon"
  | "event-store"
  | "checkpoint"
  | "rewind";

export interface RuntimeErrorSummary {
  timestamp?: string;
  layer: RuntimeErrorLayer;
  code?: string;
  message: string;
  stack?: string;
  traceId?: string;
  sessionId?: string;
  runId?: string;
  spanId?: string;
  parentSpanId?: string;
  messageId?: string;
  toolCallId?: string;
  providerId?: string;
  routeId?: string;
  requestId?: string;
}

export interface RuntimeSpanSummary {
  spanId: string;
  parentSpanId?: string;
  traceId?: string;
  sessionId?: string;
  runId?: string;
  messageId?: string;
  toolCallId?: string;
  providerId?: string;
  routeId?: string;
  requestId?: string;
  kind: RuntimeSpanKind;
  name: string;
  status: RuntimeSpanStatus;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  input?: RuntimePayloadSummary;
  output?: RuntimePayloadSummary;
  metrics?: JsonObject;
  error?: RuntimeErrorSummary;
}

export interface RuntimeTraceSummary {
  traceId?: string;
  sessionId?: string;
  runId?: string;
  startedAt?: string;
  endedAt?: string;
  spanCount: number;
  errorCount: number;
  spans: RuntimeSpanSummary[];
  recentErrors: RuntimeErrorSummary[];
}

export interface RuntimeMetricsDimensionSnapshot extends RuntimeMetricsDimensions {
  promptAssemblyCount: number;
  providerUsage: RuntimeProviderUsageMetrics;
  cache: RuntimeCacheMetricsSnapshot;
  providerLatencyMs: RuntimeDurationMetrics;
}

export interface RuntimeStreamingMetricsSnapshot {
  textDeltaCount: number;
  textDeltaBytes: number;
  textDeltaCharacters: number;
  providerDiagnosticCount: number;
  firstTextDeltaLatencyMs?: number;
  firstProviderResponseLatencyMs?: number;
  providerStreamDurationMs?: number;
  tokensPerSecond?: number;
  textBytesPerSecond?: number;
  textCharactersPerSecond?: number;
  eventsPerSecond?: number;
  terminalEventCount?: number;
  interruptedCount?: number;
  errorCount?: number;
  terminalReasons?: Record<string, number>;
  cancelRequestedCount?: number;
  cancelObserved?: boolean;
  cancelLatencyMs?: number;
}

export interface RuntimeMetricsSnapshot {
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
  eventCount: number;
  turnCount: number;
  tools: RuntimeToolMetricsSnapshot;
  providerUsage: RuntimeProviderUsageMetrics;
  providerLatencyMs: RuntimeDurationMetrics;
  streaming: RuntimeStreamingMetricsSnapshot;
  cache: RuntimeCacheMetricsSnapshot;
  failures: RuntimeFailureMetricsSnapshot;
  trace?: RuntimeTraceSummary;
  latestDimensions?: RuntimeMetricsDimensions;
  dimensions: RuntimeMetricsDimensionSnapshot[];
  totalCost?: number;
  cacheHitRatio?: number;
  topToolNames?: string[];
  toolStats?: RuntimeToolNameMetricsSnapshot[];
}

export type RuntimePromptAssemblyInput = Partial<PromptAssemblyMetadata> | RuntimeMetricsDimensions | JsonObject | undefined;

export interface MutableToolMetrics {
  callCount: number;
  errorCount: number;
  timeoutCount: number;
  cancelCount: number;
  durationHistogram: MutableDurationHistogram;
  successCount: number;
  byteSizeTotal: number;
}

export interface MutableDimensionMetrics extends RuntimeMetricsDimensions {
  promptAssemblyCount: number;
  providerUsage: RuntimeProviderUsageMetrics;
  providerLatencyHistogram: MutableDurationHistogram;
}

export interface MutableDurationHistogram {
  count: number;
  min?: number;
  max?: number;
  totalMs: number;
  buckets: BoundedMap<number, number>;
}

export interface MutableStreamingMetrics {
  textDeltaCount: number;
  textDeltaBytes: number;
  textDeltaCharacters: number;
  providerDiagnosticCount: number;
  firstTextDeltaAt?: string;
  firstProviderResponseLatencyMs?: number;
  providerStreamDurationMs?: number;
  terminalEventCount: number;
  interruptedCount: number;
  errorCount: number;
  terminalReasons: BoundedMap<string, number>;
  cancelRequestedCount?: number;
  cancelObserved?: boolean;
  cancelLatencyMs?: number;
}

/** 计数 Map 的结构化接口，兼容 Map 和 BoundedMap。 */
export interface CounterMap {
  size: number;
  get(key: string): number | undefined;
  set(key: string, value: number): unknown;
  entries(): Iterable<[string, number]>;
}

export const MAX_TRACE_SPANS = 64;
export const MAX_TRACE_ERRORS = 32;
export const MAX_ERROR_MESSAGE_LENGTH = 512;
export const MAX_ERROR_STACK_LENGTH = 2048;
export const MAX_TOOL_NAME_METRICS = 64;
export const MAX_DIMENSION_METRICS = 64;
export const MAX_TERMINAL_REASONS = 32;
export const MAX_HISTOGRAM_BUCKETS = 256;
