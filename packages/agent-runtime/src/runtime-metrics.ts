import { createHash } from "node:crypto";
import type { PromptAssemblyMetadata } from "./prompt-assembly";
import type { AgentEvent, AgentMessage, JsonObject, ProviderDiagnostic, ToolBatchResult, ToolOutput } from "@crish/shared-types";
import { BoundedMap, RingBuffer } from "@crish/shared-utils";
import type { ProviderUsage } from "./types";

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
}

type RuntimePromptAssemblyInput = Partial<PromptAssemblyMetadata> | RuntimeMetricsDimensions | JsonObject | undefined;

interface MutableToolMetrics {
  callCount: number;
  errorCount: number;
  timeoutCount: number;
  cancelCount: number;
  durationHistogram: MutableDurationHistogram;
}

interface MutableDimensionMetrics extends RuntimeMetricsDimensions {
  promptAssemblyCount: number;
  providerUsage: RuntimeProviderUsageMetrics;
  providerLatencyHistogram: MutableDurationHistogram;
}

interface MutableDurationHistogram {
  count: number;
  min?: number;
  max?: number;
  buckets: BoundedMap<number, number>;
}

interface MutableStreamingMetrics {
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

const MAX_TRACE_SPANS = 64;
const MAX_TRACE_ERRORS = 32;
const MAX_ERROR_MESSAGE_LENGTH = 512;
const MAX_ERROR_STACK_LENGTH = 2048;
/** 工具名指标上限：工具名数量有限但需防御动态生成场景。 */
const MAX_TOOL_NAME_METRICS = 64;
/** 维度组合上限：维度键由 provider/model/cacheStrategy 等组合而成，需防爆炸。 */
const MAX_DIMENSION_METRICS = 64;
/** 流式终止原因上限：枚举型，少量即可。 */
const MAX_TERMINAL_REASONS = 32;
/** 直方图 bucket 上限：durationMs 取整后作为 key，需防任意毫秒值导致爆炸。 */
const MAX_HISTOGRAM_BUCKETS = 256;

export class RuntimeMetricsCollector {
  private sessionId: string | undefined;
  private startedAt: string | undefined;
  private endedAt: string | undefined;
  private eventCount = 0;
  private turnCount = 0;
  private readonly toolMetrics = createMutableToolMetrics();
  private readonly toolMetricsByName = new BoundedMap<string, MutableToolMetrics>(MAX_TOOL_NAME_METRICS);
  private readonly providerUsage = emptyProviderUsageMetrics();
  private readonly providerLatencyHistogram = createMutableDurationHistogram();
  private readonly streaming: MutableStreamingMetrics = {
    textDeltaCount: 0,
    textDeltaBytes: 0,
    textDeltaCharacters: 0,
    terminalEventCount: 0,
    interruptedCount: 0,
    errorCount: 0,
    terminalReasons: new BoundedMap<string, number>(MAX_TERMINAL_REASONS),
    providerDiagnosticCount: 0
  };
  private readonly dimensions = new BoundedMap<string, MutableDimensionMetrics>(MAX_DIMENSION_METRICS);
  private latestDimensions: RuntimeMetricsDimensions | undefined;
  private readonly spans = new BoundedMap<string, RuntimeSpanSummary>(MAX_TRACE_SPANS + 1);
  // 容量 MAX_TRACE_SPANS+1：保证 push 总能成功，再由 pruneSpans 用 O(1) shift 收敛到上限。
  private readonly spanOrder = new RingBuffer<string>(MAX_TRACE_SPANS + 1);
  private readonly errors: RuntimeErrorSummary[] = [];
  private activeMessageSpanId: string | undefined;
  private readonly failures: RuntimeFailureMetricsSnapshot = {
    errorCount: 0,
    runtimeErrorCount: 0,
    agentErrorCount: 0,
    providerErrorCount: 0,
    contextCompressionErrorCount: 0,
    timeoutCount: 0,
    cancelCount: 0
  };

  recordEvents(events: Iterable<AgentEvent>): void {
    for (const event of events) {
      this.recordEvent(event);
    }
  }

  recordEvent(event: AgentEvent): void {
    this.eventCount += 1;
    this.recordSession(event.sessionId);

    if ("timestamp" in event) {
      this.startedAt ??= event.timestamp;
      this.endedAt = event.timestamp;
    }

    switch (event.type) {
      case "agent-start":
        this.startedAt = event.timestamp;
        this.startOrUpdateSpan({
          spanId: rootSpanId(event.sessionId),
          kind: "conversation",
          name: "conversation",
          status: "in-progress",
          sessionId: event.sessionId,
          startedAt: event.timestamp
        });
        break;
      case "agent-end":
        this.endedAt = event.timestamp;
        this.recordAgentEnd(event.reason, event.error);
        this.finishSpan(rootSpanId(event.sessionId), event.timestamp, event.reason === "stop" ? "ok" : event.reason === "aborted" ? "cancelled" : "error", {
          error: event.error ? this.errorSummary("agent", event.error, event.timestamp, { spanId: rootSpanId(event.sessionId) }) : undefined
        });
        break;
      case "turn-start":
        this.turnCount += 1;
        break;
      case "context-compression-end":
        this.recordContextCompressionEnd(event.aborted, event.error);
        break;
      case "provider-diagnostic":
        this.recordProviderDiagnostic(event.diagnostic, event);
        break;
      case "message-delta":
        this.recordMessageDelta(event);
        break;
      case "message-start":
        this.recordMessageStart(event);
        break;
      case "message-end":
        this.recordMessageEnd(event);
        break;
      case "tool-start":
        this.recordToolStart(event);
        break;
      case "tool-end":
        this.recordToolResult(event.result, event);
        break;
      case "checkpoint-created":
        this.recordCheckpointSpan(event.timestamp, event.checkpoint.toolCallId, "checkpoint-created", event.checkpoint.label, event.checkpoint.metadata);
        break;
      case "checkpoint-restored":
        this.recordCheckpointSpan(event.timestamp, event.restore.toolCallId, "checkpoint-restored", event.restore.checkpointId, event.restore.metadata);
        break;
      case "runtime-error":
        this.recordRuntimeError(event.error, event.timestamp);
        break;
      default:
        break;
    }
  }

  recordProviderUsage(usage: ProviderUsage | JsonObject | undefined, dimensions?: RuntimeMetricsDimensions): void {
    const normalized = normalizeProviderUsage(usage);
    if (!normalized) return;

    addProviderUsage(this.providerUsage, normalized);
    const mergedDimensions = compactDimensions({ ...(this.latestDimensions ?? {}), ...(dimensions ?? {}) });
    if (Object.keys(mergedDimensions).length > 0) {
      this.latestDimensions = mergedDimensions;
      const bucket = this.dimensionBucket(mergedDimensions);
      addProviderUsage(bucket.providerUsage, normalized);
    }
  }

  recordPromptAssembly(metadata: RuntimePromptAssemblyInput): void {
    const dimensions = dimensionsFromPromptAssembly(metadata);
    if (!dimensions) return;

    this.latestDimensions = compactDimensions({ ...(this.latestDimensions ?? {}), ...dimensions });
    const bucket = this.dimensionBucket(this.latestDimensions);
    bucket.promptAssemblyCount += 1;
  }

  recordToolResult(result: ToolBatchResult, event?: Extract<AgentEvent, { type: "tool-end" }>): void {
    const durationMs = finiteNonNegativeNumber(result.durationMs);
    const toolName = result.toolName || "<unknown>";
    const named = this.toolMetricsByName.get(toolName) ?? createMutableToolMetrics();
    this.toolMetricsByName.set(toolName, named);

    this.toolMetrics.callCount += 1;
    named.callCount += 1;
    if (durationMs !== undefined) {
      recordDuration(this.toolMetrics.durationHistogram, durationMs);
      recordDuration(named.durationHistogram, durationMs);
    }

    if (result.isError) {
      this.toolMetrics.errorCount += 1;
      named.errorCount += 1;
      this.failures.errorCount += 1;
    }

    const outcome = classifyToolOutcome(result.output);
    if (outcome.timeout) {
      this.toolMetrics.timeoutCount += 1;
      named.timeoutCount += 1;
      this.failures.timeoutCount += 1;
    }
    if (outcome.cancel) {
      this.toolMetrics.cancelCount += 1;
      named.cancelCount += 1;
      this.failures.cancelCount += 1;
    }

    if (event) {
      const status: RuntimeSpanStatus = result.isError
        ? outcome.timeout
          ? "timeout"
          : outcome.cancel
            ? "cancelled"
            : "error"
        : "ok";
      const error = result.isError
        ? this.errorSummary("tool", toolErrorMessage(result), event.timestamp, {
            spanId: toolSpanId(result.id),
            toolCallId: result.id
          })
        : undefined;
      this.finishSpan(toolSpanId(result.id), event.timestamp, status, {
        output: payloadSummary(result.output),
        durationMs,
        error
      });
    }
  }

  snapshot(): RuntimeMetricsSnapshot {
    const tools = snapshotToolMetrics(this.toolMetrics, this.toolMetricsByName);
    return compactSnapshot({
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      eventCount: this.eventCount,
      turnCount: this.turnCount,
      tools,
      providerUsage: cloneProviderUsage(this.providerUsage),
      providerLatencyMs: durationMetrics(this.providerLatencyHistogram),
      streaming: snapshotStreamingMetrics(this.streaming, this.startedAt, this.endedAt, this.eventCount),
      cache: cacheMetricsFromProviderUsage(this.providerUsage),
      failures: { ...this.failures },
      trace: this.traceSummary(),
      latestDimensions: this.latestDimensions ? { ...this.latestDimensions } : undefined,
      dimensions: Array.from(this.dimensions.values()).map(snapshotDimensionMetrics)
    });
  }

  private recordSession(sessionId: string): void {
    this.sessionId ??= sessionId;
  }

  private recordAgentEnd(reason: "stop" | "max-turns" | "aborted" | "error", error: string | undefined): void {
    if (reason === "aborted") {
      this.failures.cancelCount += 1;
      this.streaming.terminalEventCount += 1;
      this.streaming.interruptedCount += 1;
      incrementMap(this.streaming.terminalReasons, "aborted");
      return;
    }
    if (reason !== "error") return;
    this.streaming.terminalEventCount += 1;
    this.streaming.errorCount += 1;
    incrementMap(this.streaming.terminalReasons, "agent-error");
    this.failures.agentErrorCount += 1;
    this.failures.errorCount += 1;
    this.recordFailureClass(error);
  }

  private recordContextCompressionEnd(aborted: boolean, error: string | undefined): void {
    if (aborted) this.failures.cancelCount += 1;
    if (!error) return;
    this.failures.contextCompressionErrorCount += 1;
    this.failures.errorCount += 1;
    this.recordFailureClass(error);
  }

  private recordProviderDiagnostic(diagnostic: ProviderDiagnostic, event?: Extract<AgentEvent, { type: "provider-diagnostic" }>): void {
    const dimensions = compactDimensions({
      ...(this.latestDimensions ?? {}),
      providerId: diagnostic.providerId,
      configuredModel: diagnostic.configuredModel,
      actualModel: diagnostic.actualModel
    });
    if (Object.keys(dimensions).length > 0) this.latestDimensions = dimensions;
    this.streaming.providerDiagnosticCount += 1;

    if (diagnostic.elapsedMs !== undefined) {
      const durationMs = finiteNonNegativeNumber(diagnostic.elapsedMs);
      if (durationMs !== undefined && isProviderLatencyPhase(diagnostic.phase)) {
        recordDuration(this.providerLatencyHistogram, durationMs);
        if (Object.keys(dimensions).length > 0) {
          recordDuration(this.dimensionBucket(dimensions).providerLatencyHistogram, durationMs);
        }
      }
      if (durationMs !== undefined && diagnostic.phase === "response-start") {
        this.streaming.firstProviderResponseLatencyMs ??= durationMs;
      }
      if (durationMs !== undefined && diagnostic.phase === "stream-end") {
        this.streaming.providerStreamDurationMs = durationMs;
      }
    }

    if (diagnostic.phase === "stream-end") {
      this.streaming.terminalEventCount += 1;
      incrementMap(this.streaming.terminalReasons, "stream-end");
    } else if (diagnostic.phase === "request-error") {
      this.streaming.terminalEventCount += 1;
      this.streaming.errorCount += 1;
      if (isInterruptedProviderDiagnostic(diagnostic)) this.streaming.interruptedCount += 1;
      incrementMap(this.streaming.terminalReasons, diagnostic.errorKind ?? "request-error");
    }

    this.recordProviderSpan(diagnostic, event?.timestamp);

    if (diagnostic.phase !== "request-error") return;
    this.failures.providerErrorCount += 1;
    this.failures.errorCount += 1;
    this.recordFailureClass([diagnostic.reason, diagnostic.statusText, diagnostic.errorKind].filter(Boolean).join(" "));
  }

  private recordMessageDelta(event: Extract<AgentEvent, { type: "message-delta" }>): void {
    if (event.block.type !== "text" || event.block.text.length === 0) return;
    this.streaming.textDeltaCount += 1;
    this.streaming.textDeltaCharacters += event.block.text.length;
    this.streaming.textDeltaBytes += Buffer.byteLength(event.block.text, "utf8");
    const timestamp = eventTimestamp(event) ?? new Date().toISOString();
    if (this.streaming.firstTextDeltaAt === undefined) {
      this.streaming.firstTextDeltaAt = timestamp;
    }
  }

  private recordMessageStart(event: Extract<AgentEvent, { type: "message-start" }>): void {
    const spanId = messageSpanId(event.message.id);
    this.activeMessageSpanId = spanId;
    this.startOrUpdateSpan({
      spanId,
      parentSpanId: rootSpanId(event.sessionId),
      kind: "message",
      name: `${event.message.role}-message`,
      status: "in-progress",
      sessionId: event.sessionId,
      messageId: event.message.id,
      startedAt: event.message.createdAt
    });
  }

  private recordMessageEnd(event: Extract<AgentEvent, { type: "message-end" }>): void {
    const message = event.message;
    const metadata = objectRecord(message.metadata);
    const promptAssembly = metadata ? metadata.promptAssembly : undefined;
    const usage = metadata ? metadata.usage : undefined;
    this.recordPromptAssembly(promptAssembly as RuntimePromptAssemblyInput);
    this.recordProviderUsage(usage as ProviderUsage | JsonObject | undefined);
    const error = stringField(metadata?.error);
    const stopReason = stringField(metadata?.stopReason);
    if (stopReason) {
      this.streaming.terminalEventCount += 1;
      incrementMap(this.streaming.terminalReasons, stopReason);
      if (stopReason === "error") this.streaming.errorCount += 1;
      if (isInterruptedText(error ?? stopReason)) this.streaming.interruptedCount += 1;
    }
    this.finishSpan(messageSpanId(message.id), message.createdAt, error ? "error" : "ok", {
      output: payloadSummary(message.blocks),
      error: error
        ? this.errorSummary("agent", error, message.createdAt, {
            spanId: messageSpanId(message.id),
            messageId: message.id
          })
        : undefined
    });
  }

  private recordToolStart(event: Extract<AgentEvent, { type: "tool-start" }>): void {
    this.startOrUpdateSpan({
      spanId: toolSpanId(event.call.id),
      parentSpanId: this.activeMessageSpanId ?? rootSpanId(event.sessionId),
      kind: isShellToolName(event.call.toolName) ? "shell-command" : "tool-call",
      name: event.call.toolName,
      status: "in-progress",
      sessionId: event.sessionId,
      toolCallId: event.call.id,
      startedAt: event.timestamp,
      input: payloadSummary(event.call.input),
      metrics: {
        category: event.call.category,
        concurrency: event.call.concurrency
      }
    });
  }

  private recordRuntimeError(error: string, timestamp?: string): void {
    this.failures.runtimeErrorCount += 1;
    this.failures.errorCount += 1;
    this.recordFailureClass(error);
    this.recordError(this.errorSummary("runtime", error, timestamp));
  }

  private recordFailureClass(value: unknown): void {
    const text = typeof value === "string" ? value : "";
    if (/timeout|timed out/i.test(text)) this.failures.timeoutCount += 1;
    if (/aborted|abort|cancelled|canceled/i.test(text)) this.failures.cancelCount += 1;
  }

  private dimensionBucket(dimensions: RuntimeMetricsDimensions): MutableDimensionMetrics {
    const key = dimensionsKey(dimensions);
    const existing = this.dimensions.get(key);
    if (existing) return existing;
    const bucket: MutableDimensionMetrics = {
      ...dimensions,
      promptAssemblyCount: 0,
      providerUsage: emptyProviderUsageMetrics(),
      providerLatencyHistogram: createMutableDurationHistogram()
    };
    this.dimensions.set(key, bucket);
    return bucket;
  }

  private recordProviderSpan(diagnostic: ProviderDiagnostic, timestamp: string | undefined): void {
    const spanId = providerSpanId(diagnostic);
    const metrics = compactObject({
      phase: diagnostic.phase,
      attempt: diagnostic.attempt,
      maxAttempts: diagnostic.maxAttempts,
      status: diagnostic.status,
      retryable: diagnostic.retryable,
      chunks: diagnostic.chunks,
      bytes: diagnostic.bytes,
      configuredModel: diagnostic.configuredModel,
      actualModel: diagnostic.actualModel
    }) as JsonObject;
    this.startOrUpdateSpan({
      spanId,
      parentSpanId: this.activeMessageSpanId ?? (this.sessionId ? rootSpanId(this.sessionId) : undefined),
      kind: "model-stream",
      name: diagnostic.endpoint ? `provider:${diagnostic.endpoint}` : "provider-stream",
      status: "in-progress",
      sessionId: this.sessionId,
      providerId: diagnostic.providerId,
      startedAt: timestamp,
      metrics
    });
    if (diagnostic.phase !== "stream-end" && diagnostic.phase !== "request-error") return;
    const error =
      diagnostic.phase === "request-error"
        ? this.errorSummary("provider", diagnostic.reason ?? diagnostic.statusText ?? diagnostic.errorKind ?? "Provider request failed", timestamp, {
            spanId,
            providerId: diagnostic.providerId,
            code: diagnostic.errorKind
          })
        : undefined;
    this.finishSpan(spanId, timestamp, diagnostic.phase === "request-error" ? "error" : "ok", {
      durationMs: finiteNonNegativeNumber(diagnostic.elapsedMs),
      error,
      metrics
    });
  }

  private recordCheckpointSpan(
    timestamp: string,
    toolCallId: string,
    name: string,
    label: string,
    metadata: JsonObject | undefined
  ): void {
    this.startOrUpdateSpan({
      spanId: `checkpoint:${toolCallId}:${name}`,
      parentSpanId: toolSpanId(toolCallId),
      kind: "checkpoint",
      name,
      status: "ok",
      sessionId: this.sessionId,
      toolCallId,
      startedAt: timestamp,
      endedAt: timestamp,
      durationMs: 0,
      output: payloadSummary({ label, metadata })
    });
  }

  private startOrUpdateSpan(span: RuntimeSpanSummary): void {
    const existing = this.spans.get(span.spanId);
    if (!existing) {
      this.spanOrder.push(span.spanId);
      this.spans.set(span.spanId, compactSpan(span));
      this.pruneSpans();
      return;
    }
    this.spans.set(
      span.spanId,
      compactSpan({
        ...existing,
        ...span,
        metrics: compactObject({ ...(existing.metrics ?? {}), ...(span.metrics ?? {}) }) as JsonObject
      })
    );
  }

  private finishSpan(
    spanId: string,
    endedAt: string | undefined,
    status: RuntimeSpanStatus,
    updates: Partial<RuntimeSpanSummary> = {}
  ): void {
    const existing = this.spans.get(spanId) ?? {
      spanId,
      kind: "run",
      name: spanId,
      status: "in-progress" as RuntimeSpanStatus,
      sessionId: this.sessionId
    };
    if (!this.spans.has(spanId)) this.spanOrder.push(spanId);
    const durationMs =
      updates.durationMs ?? (existing.startedAt && endedAt ? isoDurationMs(existing.startedAt, endedAt) : undefined);
    const error = updates.error;
    this.spans.set(spanId, compactSpan({ ...existing, ...updates, status, endedAt, durationMs, error }));
    if (error) this.recordError(error);
    this.pruneSpans();
  }

  private recordError(error: RuntimeErrorSummary): void {
    this.errors.push(compactError(error));
    if (this.errors.length > MAX_TRACE_ERRORS) this.errors.splice(0, this.errors.length - MAX_TRACE_ERRORS);
  }

  private errorSummary(
    layer: RuntimeErrorLayer,
    message: string,
    timestamp?: string,
    context: Partial<RuntimeErrorSummary> = {}
  ): RuntimeErrorSummary {
    return compactError({
      layer,
      message: truncate(message, MAX_ERROR_MESSAGE_LENGTH),
      timestamp,
      traceId: this.sessionId,
      sessionId: this.sessionId,
      ...context,
      stack: context.stack ? truncate(context.stack, MAX_ERROR_STACK_LENGTH) : undefined
    });
  }

  private traceSummary(): RuntimeTraceSummary {
    const spans = this.spanOrder.toArray().map((spanId) => this.spans.get(spanId)).filter((span): span is RuntimeSpanSummary => Boolean(span));
    return compactObject({
      traceId: this.sessionId,
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      spanCount: spans.length,
      errorCount: this.errors.length,
      spans: spans.map((span) => compactSpan({ traceId: this.sessionId, sessionId: this.sessionId, ...span })),
      recentErrors: this.errors.map((error) => compactError({ traceId: this.sessionId, sessionId: this.sessionId, ...error }))
    }) as unknown as RuntimeTraceSummary;
  }

  private pruneSpans(): void {
    while (this.spanOrder.size > MAX_TRACE_SPANS) {
      const oldest = this.spanOrder.shift();
      if (oldest) this.spans.delete(oldest);
    }
  }
}

export function collectRuntimeMetricsSnapshot(events: Iterable<AgentEvent>): RuntimeMetricsSnapshot {
  const collector = new RuntimeMetricsCollector();
  collector.recordEvents(events);
  return collector.snapshot();
}

export function calculateRuntimeMetricPercentile(values: readonly number[], percentile: number): number | undefined {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (sorted.length === 0 || !Number.isFinite(percentile)) return undefined;
  const boundedPercentile = Math.min(100, Math.max(0, percentile));
  const rank = (boundedPercentile / 100) * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sorted[lowerIndex]!;
  const upper = sorted[upperIndex]!;
  if (lowerIndex === upperIndex) return lower;
  return lower + (upper - lower) * (rank - lowerIndex);
}

function createMutableToolMetrics(): MutableToolMetrics {
  return {
    callCount: 0,
    errorCount: 0,
    timeoutCount: 0,
    cancelCount: 0,
    durationHistogram: createMutableDurationHistogram()
  };
}

function createMutableDurationHistogram(): MutableDurationHistogram {
  return {
    count: 0,
    buckets: new BoundedMap<number, number>(MAX_HISTOGRAM_BUCKETS)
  };
}

function recordDuration(histogram: MutableDurationHistogram, durationMs: number): void {
  const bucket = Math.max(0, Math.trunc(durationMs));
  histogram.count += 1;
  histogram.min = histogram.min === undefined ? bucket : Math.min(histogram.min, bucket);
  histogram.max = histogram.max === undefined ? bucket : Math.max(histogram.max, bucket);
  histogram.buckets.set(bucket, (histogram.buckets.get(bucket) ?? 0) + 1);
}

function emptyProviderUsageMetrics(): RuntimeProviderUsageMetrics {
  return {
    sampleCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0
  };
}

function normalizeProviderUsage(usage: ProviderUsage | JsonObject | undefined): RuntimeProviderUsageMetrics | undefined {
  const record = objectRecord(usage);
  if (!record) return undefined;
  const promptDetails = objectRecord(record.prompt_tokens_details) ?? objectRecord(record.input_tokens_details) ?? {};
  const completionDetails = objectRecord(record.completion_tokens_details) ?? objectRecord(record.output_tokens_details) ?? {};
  const promptTokens = finiteNumber(record.promptTokens) ?? finiteNumber(record.prompt_tokens) ?? finiteNumber(record.input_tokens);
  const completionTokens =
    finiteNumber(record.completionTokens) ?? finiteNumber(record.completion_tokens) ?? finiteNumber(record.output_tokens);
  const totalTokens =
    finiteNumber(record.totalTokens) ??
    finiteNumber(record.total_tokens) ??
    (promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined);
  const cacheReadTokens =
    finiteNumber(record.cacheReadTokens) ??
    finiteNumber(record.cache_read_tokens) ??
    finiteNumber(record.cache_read_input_tokens) ??
    finiteNumber(promptDetails.cached_tokens);
  const cacheWriteTokens =
    finiteNumber(record.cacheWriteTokens) ??
    finiteNumber(record.cache_write_tokens) ??
    finiteNumber(record.cache_creation_input_tokens) ??
    finiteNumber(record.cache_creation_tokens);
  const reasoningTokens =
    finiteNumber(record.reasoningTokens) ?? finiteNumber(record.reasoning_tokens) ?? finiteNumber(completionDetails.reasoning_tokens);

  const normalized = emptyProviderUsageMetrics();
  let hasUsage = false;
  for (const [field, value] of [
    ["promptTokens", promptTokens],
    ["completionTokens", completionTokens],
    ["totalTokens", totalTokens],
    ["cacheReadTokens", cacheReadTokens],
    ["cacheWriteTokens", cacheWriteTokens],
    ["reasoningTokens", reasoningTokens]
  ] as const) {
    if (value === undefined) continue;
    normalized[field] = value;
    hasUsage = true;
  }
  if (!hasUsage) return undefined;
  normalized.sampleCount = 1;
  return normalized;
}

function addProviderUsage(target: RuntimeProviderUsageMetrics, usage: RuntimeProviderUsageMetrics): void {
  target.sampleCount += usage.sampleCount;
  target.promptTokens += usage.promptTokens;
  target.completionTokens += usage.completionTokens;
  target.totalTokens += usage.totalTokens;
  target.cacheReadTokens += usage.cacheReadTokens;
  target.cacheWriteTokens += usage.cacheWriteTokens;
  target.reasoningTokens += usage.reasoningTokens;
}

function cloneProviderUsage(usage: RuntimeProviderUsageMetrics): RuntimeProviderUsageMetrics {
  return { ...usage };
}

function snapshotToolMetrics(
  metrics: MutableToolMetrics,
  byName: BoundedMap<string, MutableToolMetrics>
): RuntimeToolMetricsSnapshot {
  return {
    callCount: metrics.callCount,
    errorCount: metrics.errorCount,
    errorRate: errorRate(metrics),
    timeoutCount: metrics.timeoutCount,
    timeoutRate: timeoutRate(metrics),
    cancelCount: metrics.cancelCount,
    cancelRate: cancelRate(metrics),
    durationMs: durationMetrics(metrics.durationHistogram),
    byName: Object.fromEntries(
      Array.from(byName.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([toolName, toolMetrics]) => [
          toolName,
          {
            toolName,
            callCount: toolMetrics.callCount,
            errorCount: toolMetrics.errorCount,
            errorRate: errorRate(toolMetrics),
            timeoutCount: toolMetrics.timeoutCount,
            timeoutRate: timeoutRate(toolMetrics),
            cancelCount: toolMetrics.cancelCount,
            cancelRate: cancelRate(toolMetrics),
            durationMs: durationMetrics(toolMetrics.durationHistogram)
          }
        ])
    )
  };
}

function durationMetrics(histogram: MutableDurationHistogram): RuntimeDurationMetrics {
  if (histogram.count === 0) return { count: 0 };
  return {
    count: histogram.count,
    min: histogram.min,
    max: histogram.max,
    p50: durationHistogramPercentile(histogram, 50),
    p95: durationHistogramPercentile(histogram, 95),
    p99: durationHistogramPercentile(histogram, 99)
  };
}

function errorRate(metrics: Pick<MutableToolMetrics, "callCount" | "errorCount">): number {
  return metrics.callCount === 0 ? 0 : metrics.errorCount / metrics.callCount;
}

function timeoutRate(metrics: Pick<MutableToolMetrics, "callCount" | "timeoutCount">): number {
  return metrics.callCount === 0 ? 0 : metrics.timeoutCount / metrics.callCount;
}

function cancelRate(metrics: Pick<MutableToolMetrics, "callCount" | "cancelCount">): number {
  return metrics.callCount === 0 ? 0 : metrics.cancelCount / metrics.callCount;
}

function ratio(numerator: number, denominator: number): number {
  return denominator <= 0 ? 0 : numerator / denominator;
}

function snapshotDimensionMetrics(metrics: MutableDimensionMetrics): RuntimeMetricsDimensionSnapshot {
  return {
    ...compactDimensions(metrics),
    promptAssemblyCount: metrics.promptAssemblyCount,
    providerUsage: cloneProviderUsage(metrics.providerUsage),
    cache: cacheMetricsFromProviderUsage(metrics.providerUsage),
    providerLatencyMs: durationMetrics(metrics.providerLatencyHistogram)
  };
}

export function cacheMetricsFromProviderUsage(usage: RuntimeProviderUsageMetrics): RuntimeCacheMetricsSnapshot {
  const promptTokens = Math.max(0, Math.trunc(usage.promptTokens));
  const readTokens = Math.max(0, Math.trunc(usage.cacheReadTokens));
  const writeTokens = Math.max(0, Math.trunc(usage.cacheWriteTokens));
  return {
    sampleCount: Math.max(0, Math.trunc(usage.sampleCount)),
    promptTokens,
    readTokens,
    writeTokens,
    missTokens: Math.max(0, promptTokens - readTokens),
    hitRatio: ratio(readTokens, promptTokens),
    writeRatio: ratio(writeTokens, promptTokens)
  };
}

function snapshotStreamingMetrics(
  metrics: MutableStreamingMetrics,
  startedAt: string | undefined,
  endedAt: string | undefined,
  eventCount: number
): RuntimeStreamingMetricsSnapshot {
  const totalMs = startedAt && endedAt ? isoDurationMs(startedAt, endedAt) : undefined;
  const firstTextDeltaLatencyMs =
    startedAt && metrics.firstTextDeltaAt ? isoDurationMs(startedAt, metrics.firstTextDeltaAt) : undefined;
  return compactObject({
    textDeltaCount: metrics.textDeltaCount,
    textDeltaBytes: metrics.textDeltaBytes,
    textDeltaCharacters: metrics.textDeltaCharacters,
    providerDiagnosticCount: metrics.providerDiagnosticCount,
    firstTextDeltaLatencyMs,
    firstProviderResponseLatencyMs: metrics.firstProviderResponseLatencyMs,
    providerStreamDurationMs: metrics.providerStreamDurationMs,
    tokensPerSecond: totalMs !== undefined ? ratePerSecond(metrics.textDeltaCount, totalMs) : undefined,
    textBytesPerSecond: totalMs !== undefined ? ratePerSecond(metrics.textDeltaBytes, totalMs) : undefined,
    textCharactersPerSecond: totalMs !== undefined ? ratePerSecond(metrics.textDeltaCharacters, totalMs) : undefined,
    eventsPerSecond: totalMs !== undefined ? ratePerSecond(eventCount, totalMs) : undefined,
    terminalEventCount: metrics.terminalEventCount,
    interruptedCount: metrics.interruptedCount,
    errorCount: metrics.errorCount,
    terminalReasons: mapToRecord(metrics.terminalReasons),
    cancelRequestedCount: metrics.cancelRequestedCount,
    cancelObserved: metrics.cancelObserved,
    cancelLatencyMs: metrics.cancelLatencyMs
  }) as unknown as RuntimeStreamingMetricsSnapshot;
}

function durationHistogramPercentile(histogram: MutableDurationHistogram, percentile: number): number | undefined {
  if (histogram.count === 0 || !Number.isFinite(percentile)) return undefined;
  const sortedValues = [...histogram.buckets.entries()].sort(([left], [right]) => left - right);
  const boundedPercentile = Math.min(100, Math.max(0, percentile));
  const rank = (boundedPercentile / 100) * (histogram.count - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = durationAtIndex(sortedValues, lowerIndex);
  const upper = durationAtIndex(sortedValues, upperIndex);
  if (lower === undefined || upper === undefined) return undefined;
  return lowerIndex === upperIndex ? lower : lower + (upper - lower) * (rank - lowerIndex);
}

function durationAtIndex(sortedValues: Array<[number, number]>, index: number): number | undefined {
  let seen = 0;
  for (const [value, count] of sortedValues) {
    if (index < seen + count) return value;
    seen += count;
  }
  return undefined;
}

function isProviderLatencyPhase(phase: ProviderDiagnostic["phase"]): boolean {
  return phase === "response-start" || phase === "stream-end" || phase === "request-error";
}

function isInterruptedProviderDiagnostic(diagnostic: ProviderDiagnostic): boolean {
  return (
    diagnostic.errorKind === "cancelled" ||
    diagnostic.errorKind === "timeout" ||
    diagnostic.errorKind === "invalid-stream" ||
    isInterruptedText([diagnostic.reason, diagnostic.statusText].filter(Boolean).join(" "))
  );
}

function isInterruptedText(value: string | undefined): boolean {
  return value !== undefined && /aborted|abort|cancelled|canceled|interrupt|timeout|timed out|invalid-stream/i.test(value);
}

/** 计数 Map 的结构化接口，兼容 Map 和 BoundedMap。 */
interface CounterMap {
  size: number;
  get(key: string): number | undefined;
  set(key: string, value: number): unknown;
  entries(): Iterable<[string, number]>;
}

function incrementMap(map: CounterMap, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function mapToRecord(map: CounterMap): Record<string, number> | undefined {
  if (map.size === 0) return undefined;
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function dimensionsFromPromptAssembly(metadata: RuntimePromptAssemblyInput): RuntimeMetricsDimensions | undefined {
  const record = objectRecord(metadata);
  if (!record) return undefined;
  const dimensions = compactDimensions({
    providerFamily: stringField(record.providerFamily),
    providerId: stringField(record.providerId),
    modelFamily: stringField(record.modelFamily),
    configuredModel: stringField(record.configuredModel),
    actualModel: stringField(record.actualModel),
    cacheStrategy: stringField(record.cacheStrategy),
    stablePrefixHash: stringField(record.stablePrefixHash),
    toolSchemaHash: stringField(record.toolSchemaHash),
    cacheKey: stringField(record.cacheKey)
  });
  return Object.keys(dimensions).length > 0 ? dimensions : undefined;
}

function compactDimensions(dimensions: RuntimeMetricsDimensions): RuntimeMetricsDimensions {
  return compactObject({
    providerFamily: stringField(dimensions.providerFamily),
    providerId: stringField(dimensions.providerId),
    modelFamily: stringField(dimensions.modelFamily),
    configuredModel: stringField(dimensions.configuredModel),
    actualModel: stringField(dimensions.actualModel),
    cacheStrategy: stringField(dimensions.cacheStrategy),
    stablePrefixHash: stringField(dimensions.stablePrefixHash),
    toolSchemaHash: stringField(dimensions.toolSchemaHash),
    cacheKey: stringField(dimensions.cacheKey)
  }) as RuntimeMetricsDimensions;
}

function dimensionsKey(dimensions: RuntimeMetricsDimensions): string {
  return JSON.stringify(
    Object.entries(dimensions)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function classifyToolOutcome(output: ToolOutput): { timeout: boolean; cancel: boolean } {
  const values = collectOutcomeValues(output.json);
  if (output.text) values.push(output.text);
  const text = values.join(" ");
  return {
    timeout: /\b(?:timed[-\s]?out|timeout)\b/i.test(text),
    cancel: /\b(?:cancelled|canceled|aborted|abort)\b/i.test(text)
  };
}

function payloadSummary(value: unknown): RuntimePayloadSummary {
  const serialized = stableJson(value);
  const keys = topLevelKeys(value);
  return compactObject({
    kind: "json",
    byteSize: Buffer.byteLength(serialized, "utf8"),
    sha256: createHash("sha256").update(serialized).digest("hex"),
    redacted: true,
    keys
  }) as unknown as RuntimePayloadSummary;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeJsonForHash(value));
}

function normalizeJsonForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJsonForHash);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeJsonForHash(item)])
  );
}

function topLevelKeys(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value).sort();
  return keys.length > 0 ? keys.slice(0, 24) : undefined;
}

function rootSpanId(sessionId: string): string {
  return `conversation:${sessionId}`;
}

function messageSpanId(messageId: string): string {
  return `message:${messageId}`;
}

function toolSpanId(toolCallId: string): string {
  return `tool:${toolCallId}`;
}

function providerSpanId(diagnostic: ProviderDiagnostic): string {
  const providerId = diagnostic.providerId ?? "provider";
  const attempt = diagnostic.attempt ?? 1;
  const endpoint = diagnostic.endpoint ?? "stream";
  return `provider:${providerId}:${endpoint}:${attempt}`;
}

function isShellToolName(toolName: string): boolean {
  return /^(?:shell|shell_command|command|exec|terminal)$/i.test(toolName);
}

function toolErrorMessage(result: ToolBatchResult): string {
  return firstStringValue(result.output.json) ?? result.output.text ?? `Tool failed: ${result.toolName}`;
}

function firstStringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstStringValue(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return firstStringValue(record.error) ?? firstStringValue(record.message) ?? firstStringValue(record.reason);
}

function eventTimestamp(event: AgentEvent): string | undefined {
  return "timestamp" in event && typeof event.timestamp === "string" ? event.timestamp : undefined;
}

function isoDurationMs(startedAt: string, endedAt: string): number | undefined {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return Math.max(0, end - start);
}

function ratePerSecond(count: number, elapsedMs: number): number | undefined {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return undefined;
  return count / (elapsedMs / 1000);
}

function compactSpan(span: RuntimeSpanSummary): RuntimeSpanSummary {
  return compactObject(span as unknown as Record<string, unknown>) as unknown as RuntimeSpanSummary;
}

function compactError(error: RuntimeErrorSummary): RuntimeErrorSummary {
  return compactObject(error as unknown as Record<string, unknown>) as unknown as RuntimeErrorSummary;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function collectOutcomeValues(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(collectOutcomeValues);
  if (typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const directValues = [
    record.timedOut === true ? "timeout" : undefined,
    record.cancelled === true ? "cancelled" : undefined,
    record.canceled === true ? "canceled" : undefined,
    stringField(record.state),
    stringField(record.reason),
    stringField(record.signal),
    stringField(record.error),
    stringField(record.message)
  ].filter((item): item is string => item !== undefined);
  return [...directValues, ...Object.values(record).flatMap(collectOutcomeValues)];
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  const numberValue = finiteNumber(value);
  return numberValue !== undefined && numberValue >= 0 ? numberValue : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function compactSnapshot(input: RuntimeMetricsSnapshot): RuntimeMetricsSnapshot {
  return compactObject(input as unknown as Record<string, unknown>) as unknown as RuntimeMetricsSnapshot;
}
