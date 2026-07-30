import type {
  AgentEvent,
  JsonObject,
  ProviderDiagnostic,
  ToolBatchResult,
  ProviderUsage,
} from '@crish/shared-types';
import { BoundedMap, RingBuffer } from "@crish/shared-utils";
import type { TokenLedger } from "@crish/agent-model";
import {
  type RuntimeMetricsSnapshot, type RuntimeMetricsDimensions,
  type RuntimeFailureMetricsSnapshot, type RuntimeErrorSummary,
  type RuntimeSpanSummary, type RuntimeSpanStatus, type RuntimePromptAssemblyInput,
  type MutableToolMetrics, type MutableDimensionMetrics, type MutableStreamingMetrics,
  MAX_TRACE_SPANS, MAX_TRACE_ERRORS, MAX_DIMENSION_METRICS, MAX_TERMINAL_REASONS, MAX_TOOL_NAME_METRICS,
} from "./types";
import {
  createMutableToolMetrics, createMutableDurationHistogram, emptyProviderUsageMetrics, normalizeProviderUsage,
  addProviderUsage, cloneProviderUsage, snapshotToolMetrics, toolStatsSnapshot, durationMetrics,
  snapshotDimensionMetrics, cacheMetricsFromProviderUsage, snapshotStreamingMetrics, compactDimensions,
  dimensionsKey, classifyToolOutcome, payloadSummary, errorSummary, traceSummary, isProviderLatencyPhase,
  isInterruptedProviderDiagnostic, isInterruptedText, rootSpanId, messageSpanId, toolSpanId, providerSpanId,
  isShellToolName, toolErrorMessage, eventTimestamp, isoDurationMs, incrementMap, recordDuration,
  compactSpan, compactError, compactSnapshot, dimensionsFromPromptAssembly, compactObject, objectRecord, stringField,
  finiteNonNegativeNumber,
} from "./snapshot";

export class RuntimeMetricsCollector {
  private sessionId: string | undefined;
  private startedAt: string | undefined;
  private endedAt: string | undefined;
  private eventCount = 0;
  private turnCount = 0;
  private readonly toolMetrics = createMutableToolMetrics();
  private readonly toolMetricsByName = new BoundedMap<string, MutableToolMetrics>(MAX_TOOL_NAME_METRICS, undefined);
  private readonly providerUsage = emptyProviderUsageMetrics();
  private readonly providerLatencyHistogram = createMutableDurationHistogram();
  private readonly streaming: MutableStreamingMetrics = {
    textDeltaCount: 0, textDeltaBytes: 0, textDeltaCharacters: 0, terminalEventCount: 0, interruptedCount: 0,
    errorCount: 0, terminalReasons: new BoundedMap<string, number>(MAX_TERMINAL_REASONS, undefined), providerDiagnosticCount: 0
  };
  private readonly dimensions = new BoundedMap<string, MutableDimensionMetrics>(MAX_DIMENSION_METRICS, undefined);
  private latestDimensions: RuntimeMetricsDimensions | undefined;
  private readonly spans = new BoundedMap<string, RuntimeSpanSummary>(MAX_TRACE_SPANS + 1, undefined);
  private readonly spanOrder = new RingBuffer<string>(MAX_TRACE_SPANS + 1);
  private readonly errors = new RingBuffer<RuntimeErrorSummary>(MAX_TRACE_ERRORS);
  private activeMessageSpanId: string | undefined;
  private readonly failures: RuntimeFailureMetricsSnapshot = {
    errorCount: 0, runtimeErrorCount: 0, agentErrorCount: 0, providerErrorCount: 0,
    contextCompressionErrorCount: 0, timeoutCount: 0, cancelCount: 0
  };
  private totalCost: number | undefined;
  private cacheHitRatio: number | undefined;
  private topToolNames: string[] | undefined;

  recordEvents(events: Iterable<AgentEvent>): void {
    for (const event of events) this.recordEvent(event);
  }

  attachLedger(ledger: TokenLedger): void {
    this.totalCost = ledger.getTotalCost();
    this.cacheHitRatio = ledger.getCacheHitRatio();
    const toolCallCount = new Map<string, number>();
    for (const entry of ledger.getAllEntries()) {
      for (const exec of entry.toolExecutions ?? []) toolCallCount.set(exec.toolName, (toolCallCount.get(exec.toolName) ?? 0) + 1);
    }
    const sorted = Array.from(toolCallCount.entries()).sort(([, a], [, b]) => b - a).map(([name]) => name);
    this.topToolNames = sorted.length > 0 ? sorted : undefined;
  }

  recordEvent(event: AgentEvent): void {
    this.eventCount += 1;
    this.recordSession(event.sessionId);
    if ("timestamp" in event) { this.startedAt ??= event.timestamp; this.endedAt = event.timestamp; }
    switch (event.type) {
      case "agent-start":
        this.startedAt = event.timestamp;
        this.startOrUpdateSpan({ spanId: rootSpanId(event.sessionId), kind: "conversation", name: "conversation", status: "in-progress", sessionId: event.sessionId, startedAt: event.timestamp });
        break;
      case "agent-end":
        this.endedAt = event.timestamp;
        this.recordAgentEnd(event.reason, event.error);
        this.finishSpan(rootSpanId(event.sessionId), event.timestamp, event.reason === "stop" ? "ok" : event.reason === "aborted" ? "cancelled" : "error", {
          ...(event.error ? { error: errorSummary(this.sessionId, "agent", event.error, event.timestamp, { spanId: rootSpanId(event.sessionId) }) } : {})
        });
        break;
      case "turn-start": this.turnCount += 1; break;
      case "context-compression-end": this.recordContextCompressionEnd(event.aborted, event.error); break;
      case "provider-diagnostic": this.recordProviderDiagnostic(event.diagnostic, event); break;
      case "message-delta": this.recordMessageDelta(event); break;
      case "message-start": this.recordMessageStart(event); break;
      case "message-end": this.recordMessageEnd(event); break;
      case "tool-start": this.recordToolStart(event); break;
      case "tool-end": this.recordToolResult(event.result, event); break;
      case "checkpoint-created": this.recordCheckpointSpan(event.timestamp, event.checkpoint.toolCallId, "checkpoint-created", event.checkpoint.label, event.checkpoint.metadata); break;
      case "checkpoint-restored": this.recordCheckpointSpan(event.timestamp, event.restore.toolCallId, "checkpoint-restored", event.restore.checkpointId, event.restore.metadata); break;
      case "runtime-error": this.recordRuntimeError(event.error, event.timestamp); break;
      default: break;
    }
  }

  recordProviderUsage(usage: ProviderUsage | JsonObject | undefined, dimensions?: RuntimeMetricsDimensions): void {
    const normalized = normalizeProviderUsage(usage);
    if (!normalized) return;
    addProviderUsage(this.providerUsage, normalized);
    const mergedDimensions = compactDimensions({ ...(this.latestDimensions ?? {}), ...(dimensions ?? {}) });
    if (Object.keys(mergedDimensions).length > 0) {
      this.latestDimensions = mergedDimensions;
      addProviderUsage(this.dimensionBucket(mergedDimensions).providerUsage, normalized);
    }
  }

  recordPromptAssembly(metadata: RuntimePromptAssemblyInput): void {
    const dimensions = dimensionsFromPromptAssembly(metadata);
    if (!dimensions) return;
    this.latestDimensions = compactDimensions({ ...(this.latestDimensions ?? {}), ...dimensions });
    this.dimensionBucket(this.latestDimensions).promptAssemblyCount += 1;
  }

  recordToolResult(result: ToolBatchResult, event?: Extract<AgentEvent, { type: "tool-end" }>): void {
    const durationMs = finiteNonNegativeNumber(result.durationMs);
    const toolName = result.toolName || "<unknown>";
    const named = this.toolMetricsByName.get(toolName) ?? createMutableToolMetrics();
    this.toolMetricsByName.set(toolName, named);
    this.toolMetrics.callCount += 1;
    named.callCount += 1;
    if (durationMs !== undefined) { recordDuration(this.toolMetrics.durationHistogram, durationMs); recordDuration(named.durationHistogram, durationMs); }
    if (result.isError) { this.toolMetrics.errorCount += 1; named.errorCount += 1; this.failures.errorCount += 1; }
    else { this.toolMetrics.successCount += 1; named.successCount += 1; }
    const outputStr = result.output.text ?? (result.output.json !== undefined ? JSON.stringify(result.output.json) : "");
    const byteSize = outputStr ? Buffer.byteLength(outputStr, "utf8") : 0;
    this.toolMetrics.byteSizeTotal += byteSize;
    named.byteSizeTotal += byteSize;
    const outcome = classifyToolOutcome(result.output);
    if (outcome.timeout) { this.toolMetrics.timeoutCount += 1; named.timeoutCount += 1; this.failures.timeoutCount += 1; }
    if (outcome.cancel) { this.toolMetrics.cancelCount += 1; named.cancelCount += 1; this.failures.cancelCount += 1; }
    if (event) {
      const status: RuntimeSpanStatus = result.isError ? outcome.timeout ? "timeout" : outcome.cancel ? "cancelled" : "error" : "ok";
      const error = result.isError ? errorSummary(this.sessionId, "tool", toolErrorMessage(result), event.timestamp, { spanId: toolSpanId(result.id), toolCallId: result.id }) : undefined;
      this.finishSpan(toolSpanId(result.id), event.timestamp, status, { output: payloadSummary(result.output), ...(durationMs !== undefined ? { durationMs } : {}), ...(error !== undefined ? { error } : {}) });
    }
  }

  snapshot(): RuntimeMetricsSnapshot {
    const tools = snapshotToolMetrics(this.toolMetrics, this.toolMetricsByName);
    const trace = traceSummary(this.sessionId, this.startedAt, this.endedAt, this.spanOrder, this.spans, this.errors);
    return compactSnapshot({
      ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      ...(this.startedAt !== undefined ? { startedAt: this.startedAt } : {}),
      ...(this.endedAt !== undefined ? { endedAt: this.endedAt } : {}),
      eventCount: this.eventCount,
      turnCount: this.turnCount, tools, providerUsage: cloneProviderUsage(this.providerUsage),
      providerLatencyMs: durationMetrics(this.providerLatencyHistogram),
      streaming: snapshotStreamingMetrics(this.streaming, this.startedAt, this.endedAt, this.eventCount),
      cache: cacheMetricsFromProviderUsage(this.providerUsage), failures: { ...this.failures },
      trace,
      ...(this.latestDimensions ? { latestDimensions: { ...this.latestDimensions } } : {}),
      dimensions: Array.from(this.dimensions.values()).map(snapshotDimensionMetrics),
      ...(this.totalCost !== undefined ? { totalCost: this.totalCost } : {}),
      ...(this.cacheHitRatio !== undefined ? { cacheHitRatio: this.cacheHitRatio } : {}),
      ...(this.topToolNames !== undefined ? { topToolNames: this.topToolNames } : {}),
      toolStats: toolStatsSnapshot(this.toolMetricsByName),
    } as unknown as RuntimeMetricsSnapshot);
  }

  private recordSession(sessionId: string): void { this.sessionId ??= sessionId; }

  private recordAgentEnd(reason: "stop" | "max-turns" | "aborted" | "error", error: string | undefined): void {
    if (reason === "aborted") { this.failures.cancelCount += 1; this.streaming.terminalEventCount += 1; this.streaming.interruptedCount += 1; incrementMap(this.streaming.terminalReasons, "aborted"); return; }
    if (reason !== "error") return;
    this.streaming.terminalEventCount += 1; this.streaming.errorCount += 1; incrementMap(this.streaming.terminalReasons, "agent-error");
    this.failures.agentErrorCount += 1; this.failures.errorCount += 1; this.recordFailureClass(error);
  }

  private recordContextCompressionEnd(aborted: boolean, error: string | undefined): void {
    if (aborted) this.failures.cancelCount += 1;
    if (!error) return;
    this.failures.contextCompressionErrorCount += 1; this.failures.errorCount += 1; this.recordFailureClass(error);
  }

  private recordProviderDiagnostic(diagnostic: ProviderDiagnostic, event?: Extract<AgentEvent, { type: "provider-diagnostic" }>): void {
    const dimensions = compactDimensions({ ...(this.latestDimensions ?? {}), providerId: diagnostic.providerId, configuredModel: diagnostic.configuredModel, actualModel: diagnostic.actualModel } as RuntimeMetricsDimensions);
    if (Object.keys(dimensions).length > 0) this.latestDimensions = dimensions;
    this.streaming.providerDiagnosticCount += 1;
    if (diagnostic.elapsedMs !== undefined) {
      const durationMs = finiteNonNegativeNumber(diagnostic.elapsedMs);
      if (durationMs !== undefined && isProviderLatencyPhase(diagnostic.phase)) {
        recordDuration(this.providerLatencyHistogram, durationMs);
        if (Object.keys(dimensions).length > 0) recordDuration(this.dimensionBucket(dimensions).providerLatencyHistogram, durationMs);
      }
      if (durationMs !== undefined && diagnostic.phase === "response-start") this.streaming.firstProviderResponseLatencyMs ??= durationMs;
      if (durationMs !== undefined && diagnostic.phase === "stream-end") this.streaming.providerStreamDurationMs = durationMs;
    }
    if (diagnostic.phase === "stream-end") { this.streaming.terminalEventCount += 1; incrementMap(this.streaming.terminalReasons, "stream-end"); }
    else if (diagnostic.phase === "request-error") {
      this.streaming.terminalEventCount += 1; this.streaming.errorCount += 1;
      if (isInterruptedProviderDiagnostic(diagnostic)) this.streaming.interruptedCount += 1;
      incrementMap(this.streaming.terminalReasons, diagnostic.errorKind ?? "request-error");
    }
    this.recordProviderSpan(diagnostic, event?.timestamp);
    if (diagnostic.phase !== "request-error") return;
    this.failures.providerErrorCount += 1; this.failures.errorCount += 1;
    this.recordFailureClass([diagnostic.reason, diagnostic.statusText, diagnostic.errorKind].filter(Boolean).join(" "));
  }

  private recordMessageDelta(event: Extract<AgentEvent, { type: "message-delta" }>): void {
    if (event.block.type !== "text" || event.block.text.length === 0) return;
    this.streaming.textDeltaCount += 1;
    this.streaming.textDeltaCharacters += event.block.text.length;
    this.streaming.textDeltaBytes += Buffer.byteLength(event.block.text, "utf8");
    const timestamp = eventTimestamp(event) ?? new Date().toISOString();
    if (this.streaming.firstTextDeltaAt === undefined) this.streaming.firstTextDeltaAt = timestamp;
  }

  private recordMessageStart(event: Extract<AgentEvent, { type: "message-start" }>): void {
    const spanId = messageSpanId(event.message.id);
    this.activeMessageSpanId = spanId;
    this.startOrUpdateSpan({ spanId, parentSpanId: rootSpanId(event.sessionId), kind: "message", name: `${event.message.role}-message`, status: "in-progress", sessionId: event.sessionId, messageId: event.message.id, startedAt: event.message.createdAt });
  }

  private recordMessageEnd(event: Extract<AgentEvent, { type: "message-end" }>): void {
    const message = event.message;
    const metadata = objectRecord(message.metadata);
    this.recordPromptAssembly((metadata ? metadata.promptAssembly : undefined) as RuntimePromptAssemblyInput);
    this.recordProviderUsage((metadata ? metadata.usage : undefined) as ProviderUsage | JsonObject | undefined);
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
      ...(error ? { error: errorSummary(this.sessionId, "agent", error, message.createdAt, { spanId: messageSpanId(message.id), messageId: message.id }) } : {})
    });
  }

  private recordToolStart(event: Extract<AgentEvent, { type: "tool-start" }>): void {
    this.startOrUpdateSpan({
      spanId: toolSpanId(event.call.id), parentSpanId: this.activeMessageSpanId ?? rootSpanId(event.sessionId),
      kind: isShellToolName(event.call.toolName) ? "shell-command" : "tool-call", name: event.call.toolName,
      status: "in-progress", sessionId: event.sessionId, toolCallId: event.call.id, startedAt: event.timestamp,
      input: payloadSummary(event.call.input), metrics: { category: event.call.category, concurrency: event.call.concurrency }
    });
  }

  private recordRuntimeError(error: string, timestamp?: string): void {
    this.failures.runtimeErrorCount += 1; this.failures.errorCount += 1;
    this.recordFailureClass(error);
    this.recordError(errorSummary(this.sessionId, "runtime", error, timestamp));
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
    const bucket: MutableDimensionMetrics = { ...dimensions, promptAssemblyCount: 0, providerUsage: emptyProviderUsageMetrics(), providerLatencyHistogram: createMutableDurationHistogram() };
    this.dimensions.set(key, bucket);
    return bucket;
  }

  private recordProviderSpan(diagnostic: ProviderDiagnostic, timestamp: string | undefined): void {
    const spanId = providerSpanId(diagnostic);
    const metrics = compactObject({ phase: diagnostic.phase, attempt: diagnostic.attempt, maxAttempts: diagnostic.maxAttempts, status: diagnostic.status, retryable: diagnostic.retryable, chunks: diagnostic.chunks, bytes: diagnostic.bytes, configuredModel: diagnostic.configuredModel, actualModel: diagnostic.actualModel }) as JsonObject;
    this.startOrUpdateSpan({ spanId, ...(this.activeMessageSpanId !== undefined ? { parentSpanId: this.activeMessageSpanId } : this.sessionId ? { parentSpanId: rootSpanId(this.sessionId) } : {}), kind: "model-stream", name: diagnostic.endpoint ? `provider:${diagnostic.endpoint}` : "provider-stream", status: "in-progress", ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}), ...(diagnostic.providerId !== undefined ? { providerId: diagnostic.providerId } : {}), ...(timestamp !== undefined ? { startedAt: timestamp } : {}), metrics });
    if (diagnostic.phase !== "stream-end" && diagnostic.phase !== "request-error") return;
    const error = diagnostic.phase === "request-error"
      ? errorSummary(this.sessionId, "provider", diagnostic.reason ?? diagnostic.statusText ?? diagnostic.errorKind ?? "Provider request failed", timestamp, { spanId, ...(diagnostic.providerId !== undefined ? { providerId: diagnostic.providerId } : {}), ...(diagnostic.errorKind !== undefined ? { code: diagnostic.errorKind } : {}) })
      : undefined;
    const durationMs = finiteNonNegativeNumber(diagnostic.elapsedMs);
    this.finishSpan(spanId, timestamp, diagnostic.phase === "request-error" ? "error" : "ok", { ...(durationMs !== undefined ? { durationMs } : {}), ...(error !== undefined ? { error } : {}), ...(metrics !== undefined ? { metrics } : {}) });
  }

  private recordCheckpointSpan(timestamp: string, toolCallId: string, name: string, label: string, metadata: JsonObject | undefined): void {
    this.startOrUpdateSpan({ spanId: `checkpoint:${toolCallId}:${name}`, parentSpanId: toolSpanId(toolCallId), kind: "checkpoint", name, status: "ok", ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}), toolCallId, startedAt: timestamp, endedAt: timestamp, durationMs: 0, output: payloadSummary({ label, metadata }) });
  }

  private startOrUpdateSpan(span: RuntimeSpanSummary): void {
    const existing = this.spans.get(span.spanId);
    if (!existing) { this.spanOrder.push(span.spanId); this.spans.set(span.spanId, compactSpan(span)); this.pruneSpans(); return; }
    this.spans.set(span.spanId, compactSpan({ ...existing, ...span, ...(span.metrics !== undefined ? { metrics: compactObject({ ...(existing.metrics ?? {}), ...span.metrics }) as JsonObject } : {}) }));
  }

  private finishSpan(spanId: string, endedAt: string | undefined, status: RuntimeSpanStatus, updates: Partial<RuntimeSpanSummary> = {}): void {
    const existing: RuntimeSpanSummary = this.spans.get(spanId) ?? { spanId, kind: "run" as const, name: spanId, status: "in-progress" as RuntimeSpanStatus, sessionId: this.sessionId } as RuntimeSpanSummary;
    if (!this.spans.has(spanId)) this.spanOrder.push(spanId);
    const durationMs = updates.durationMs ?? (existing.startedAt && endedAt ? isoDurationMs(existing.startedAt, endedAt) : undefined);
    this.spans.set(spanId, compactSpan({ ...existing, ...updates, status, endedAt, durationMs } as unknown as RuntimeSpanSummary));
    if (updates.error) this.recordError(updates.error);
    this.pruneSpans();
  }

  private recordError(error: RuntimeErrorSummary): void { this.errors.pushOverwritingOldest(compactError(error)); }

  private pruneSpans(): void {
    while (this.spanOrder.size > MAX_TRACE_SPANS) { const oldest = this.spanOrder.shift(); if (oldest) this.spans.delete(oldest); }
  }
}

export function collectRuntimeMetricsSnapshot(
  events: Iterable<AgentEvent>,
  ledger?: TokenLedger
): RuntimeMetricsSnapshot {
  const collector = new RuntimeMetricsCollector();
  collector.recordEvents(events);
  if (ledger) collector.attachLedger(ledger);
  return collector.snapshot();
}
