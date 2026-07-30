import { createHash } from "node:crypto";
import type {
  AgentEvent,
  ProviderDiagnostic,
  ToolBatchResult,
  ToolOutput,
  ProviderUsage,
} from '@crish/shared-types';
import { BoundedMap, RingBuffer } from "@crish/shared-utils";
import type { JsonObject } from "@crish/shared-types";
import {
  type RuntimeMetricsSnapshot, type RuntimeMetricsDimensions, type RuntimeProviderUsageMetrics,
  type RuntimeCacheMetricsSnapshot, type RuntimeDurationMetrics, type RuntimeToolNameMetricsSnapshot,
  type RuntimeToolMetricsSnapshot, type RuntimeStreamingMetricsSnapshot, type RuntimeMetricsDimensionSnapshot,
  type MutableToolMetrics, type MutableDurationHistogram, type MutableDimensionMetrics, type MutableStreamingMetrics,
  type CounterMap, type RuntimeErrorSummary, type RuntimeSpanSummary, type RuntimeTraceSummary,
  type RuntimePayloadSummary, type RuntimePromptAssemblyInput, type RuntimeErrorLayer,
  MAX_HISTOGRAM_BUCKETS, MAX_ERROR_MESSAGE_LENGTH, MAX_ERROR_STACK_LENGTH,
} from "./types";

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

export function cacheMetricsFromProviderUsage(usage: RuntimeProviderUsageMetrics): RuntimeCacheMetricsSnapshot {
  const promptTokens = Math.max(0, Math.trunc(usage.promptTokens));
  const readTokens = Math.max(0, Math.trunc(usage.cacheReadTokens));
  const writeTokens = Math.max(0, Math.trunc(usage.cacheWriteTokens));
  return { sampleCount: Math.max(0, Math.trunc(usage.sampleCount)), promptTokens, readTokens, writeTokens, missTokens: Math.max(0, promptTokens - readTokens), hitRatio: ratio(readTokens, promptTokens), writeRatio: ratio(writeTokens, promptTokens) };
}

export function createMutableToolMetrics(): MutableToolMetrics {
  return { callCount: 0, errorCount: 0, timeoutCount: 0, cancelCount: 0, durationHistogram: createMutableDurationHistogram(), successCount: 0, byteSizeTotal: 0 };
}

export function createMutableDurationHistogram(): MutableDurationHistogram {
  return { count: 0, totalMs: 0, buckets: new BoundedMap<number, number>(MAX_HISTOGRAM_BUCKETS, undefined) };
}

export function recordDuration(histogram: MutableDurationHistogram, durationMs: number): void {
  const bucket = Math.max(0, Math.trunc(durationMs));
  histogram.count += 1; histogram.totalMs += durationMs;
  histogram.min = histogram.min === undefined ? bucket : Math.min(histogram.min, bucket);
  histogram.max = histogram.max === undefined ? bucket : Math.max(histogram.max, bucket);
  histogram.buckets.set(bucket, (histogram.buckets.get(bucket) ?? 0) + 1);
}

export function emptyProviderUsageMetrics(): RuntimeProviderUsageMetrics {
  return { sampleCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}

export function normalizeProviderUsage(usage: ProviderUsage | JsonObject | undefined): RuntimeProviderUsageMetrics | undefined {
  const record = objectRecord(usage);
  if (!record) return undefined;
  const promptDetails = objectRecord(record.prompt_tokens_details) ?? objectRecord(record.input_tokens_details) ?? {};
  const completionDetails = objectRecord(record.completion_tokens_details) ?? objectRecord(record.output_tokens_details) ?? {};
  const promptTokens = finiteNumber(record.promptTokens) ?? finiteNumber(record.prompt_tokens) ?? finiteNumber(record.input_tokens);
  const completionTokens = finiteNumber(record.completionTokens) ?? finiteNumber(record.completion_tokens) ?? finiteNumber(record.output_tokens);
  const totalTokens = finiteNumber(record.totalTokens) ?? finiteNumber(record.total_tokens) ?? (promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined);
  const cacheReadTokens = finiteNumber(record.cacheReadTokens) ?? finiteNumber(record.cache_read_tokens) ?? finiteNumber(record.cache_read_input_tokens) ?? finiteNumber(promptDetails.cached_tokens);
  const cacheWriteTokens = finiteNumber(record.cacheWriteTokens) ?? finiteNumber(record.cache_write_tokens) ?? finiteNumber(record.cache_creation_input_tokens) ?? finiteNumber(record.cache_creation_tokens);
  const reasoningTokens = finiteNumber(record.reasoningTokens) ?? finiteNumber(record.reasoning_tokens) ?? finiteNumber(completionDetails.reasoning_tokens);
  const normalized = emptyProviderUsageMetrics();
  let hasUsage = false;
  for (const [field, value] of [["promptTokens", promptTokens], ["completionTokens", completionTokens], ["totalTokens", totalTokens], ["cacheReadTokens", cacheReadTokens], ["cacheWriteTokens", cacheWriteTokens], ["reasoningTokens", reasoningTokens]] as const) {
    if (value === undefined) continue;
    normalized[field] = value; hasUsage = true;
  }
  if (!hasUsage) return undefined;
  normalized.sampleCount = 1;
  return normalized;
}

export function addProviderUsage(target: RuntimeProviderUsageMetrics, usage: RuntimeProviderUsageMetrics): void {
  target.sampleCount += usage.sampleCount; target.promptTokens += usage.promptTokens; target.completionTokens += usage.completionTokens;
  target.totalTokens += usage.totalTokens; target.cacheReadTokens += usage.cacheReadTokens; target.cacheWriteTokens += usage.cacheWriteTokens; target.reasoningTokens += usage.reasoningTokens;
}

export function cloneProviderUsage(usage: RuntimeProviderUsageMetrics): RuntimeProviderUsageMetrics { return { ...usage }; }

export function snapshotToolMetrics(metrics: MutableToolMetrics, byName: BoundedMap<string, MutableToolMetrics>): RuntimeToolMetricsSnapshot {
  return {
    callCount: metrics.callCount, errorCount: metrics.errorCount, errorRate: errorRate(metrics),
    timeoutCount: metrics.timeoutCount, timeoutRate: timeoutRate(metrics), cancelCount: metrics.cancelCount, cancelRate: cancelRate(metrics),
    durationMs: durationMetrics(metrics.durationHistogram),
    byName: Object.fromEntries(Array.from(byName.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([toolName, toolMetrics]) => [toolName, toolNameMetricsSnapshot(toolName, toolMetrics)]))
  };
}

export function toolStatsSnapshot(byName: BoundedMap<string, MutableToolMetrics>): RuntimeToolNameMetricsSnapshot[] {
  return Array.from(byName.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([toolName, metrics]) => toolNameMetricsSnapshot(toolName, metrics));
}

export function toolNameMetricsSnapshot(toolName: string, metrics: MutableToolMetrics): RuntimeToolNameMetricsSnapshot {
  const dur = durationMetrics(metrics.durationHistogram);
  return {
    toolName, callCount: metrics.callCount, errorCount: metrics.errorCount, errorRate: errorRate(metrics),
    timeoutCount: metrics.timeoutCount, timeoutRate: timeoutRate(metrics), cancelCount: metrics.cancelCount, cancelRate: cancelRate(metrics),
    durationMs: dur, avgDurationMs: metrics.callCount > 0 ? metrics.durationHistogram.totalMs / metrics.callCount : 0,
    p95DurationMs: dur.p95 ?? 0, successRate: metrics.callCount > 0 ? metrics.successCount / metrics.callCount : 1,
    byteSizeTotal: metrics.byteSizeTotal, byteSizeAvg: metrics.callCount > 0 ? metrics.byteSizeTotal / metrics.callCount : 0,
  };
}

export function durationMetrics(histogram: MutableDurationHistogram): RuntimeDurationMetrics {
  if (histogram.count === 0) return { count: 0 };
  const p50 = durationHistogramPercentile(histogram, 50);
  const p95 = durationHistogramPercentile(histogram, 95);
  const p99 = durationHistogramPercentile(histogram, 99);
  return compactObject({
    count: histogram.count,
    ...(histogram.min !== undefined ? { min: histogram.min } : {}),
    ...(histogram.max !== undefined ? { max: histogram.max } : {}),
    ...(p50 !== undefined ? { p50 } : {}),
    ...(p95 !== undefined ? { p95 } : {}),
    ...(p99 !== undefined ? { p99 } : {}),
  }) as unknown as RuntimeDurationMetrics;
}

function errorRate(metrics: Pick<MutableToolMetrics, "callCount" | "errorCount">): number { return metrics.callCount === 0 ? 0 : metrics.errorCount / metrics.callCount; }
function timeoutRate(metrics: Pick<MutableToolMetrics, "callCount" | "timeoutCount">): number { return metrics.callCount === 0 ? 0 : metrics.timeoutCount / metrics.callCount; }
function cancelRate(metrics: Pick<MutableToolMetrics, "callCount" | "cancelCount">): number { return metrics.callCount === 0 ? 0 : metrics.cancelCount / metrics.callCount; }
function ratio(numerator: number, denominator: number): number { return denominator <= 0 ? 0 : numerator / denominator; }

export function snapshotDimensionMetrics(metrics: MutableDimensionMetrics): RuntimeMetricsDimensionSnapshot {
  return { ...compactDimensions(metrics), promptAssemblyCount: metrics.promptAssemblyCount, providerUsage: cloneProviderUsage(metrics.providerUsage), cache: cacheMetricsFromProviderUsage(metrics.providerUsage), providerLatencyMs: durationMetrics(metrics.providerLatencyHistogram) };
}

export function snapshotStreamingMetrics(metrics: MutableStreamingMetrics, startedAt: string | undefined, endedAt: string | undefined, eventCount: number): RuntimeStreamingMetricsSnapshot {
  const totalMs = startedAt && endedAt ? isoDurationMs(startedAt, endedAt) : undefined;
  const firstTextDeltaLatencyMs = startedAt && metrics.firstTextDeltaAt ? isoDurationMs(startedAt, metrics.firstTextDeltaAt) : undefined;
  return compactObject({
    textDeltaCount: metrics.textDeltaCount, textDeltaBytes: metrics.textDeltaBytes, textDeltaCharacters: metrics.textDeltaCharacters,
    providerDiagnosticCount: metrics.providerDiagnosticCount, firstTextDeltaLatencyMs,
    firstProviderResponseLatencyMs: metrics.firstProviderResponseLatencyMs, providerStreamDurationMs: metrics.providerStreamDurationMs,
    tokensPerSecond: totalMs !== undefined ? ratePerSecond(metrics.textDeltaCount, totalMs) : undefined,
    textBytesPerSecond: totalMs !== undefined ? ratePerSecond(metrics.textDeltaBytes, totalMs) : undefined,
    textCharactersPerSecond: totalMs !== undefined ? ratePerSecond(metrics.textDeltaCharacters, totalMs) : undefined,
    eventsPerSecond: totalMs !== undefined ? ratePerSecond(eventCount, totalMs) : undefined,
    terminalEventCount: metrics.terminalEventCount, interruptedCount: metrics.interruptedCount, errorCount: metrics.errorCount,
    terminalReasons: mapToRecord(metrics.terminalReasons), cancelRequestedCount: metrics.cancelRequestedCount,
    cancelObserved: metrics.cancelObserved, cancelLatencyMs: metrics.cancelLatencyMs
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

export function isProviderLatencyPhase(phase: ProviderDiagnostic["phase"]): boolean { return phase === "response-start" || phase === "stream-end" || phase === "request-error"; }

export function isInterruptedProviderDiagnostic(diagnostic: ProviderDiagnostic): boolean {
  return diagnostic.errorKind === "cancelled" || diagnostic.errorKind === "timeout" || diagnostic.errorKind === "invalid-stream" || isInterruptedText([diagnostic.reason, diagnostic.statusText].filter(Boolean).join(" "));
}

export function isInterruptedText(value: string | undefined): boolean {
  return value !== undefined && /aborted|abort|cancelled|canceled|interrupt|timeout|timed out|invalid-stream/i.test(value);
}

export function incrementMap(map: CounterMap, key: string): void { map.set(key, (map.get(key) ?? 0) + 1); }

export function mapToRecord(map: CounterMap): Record<string, number> | undefined {
  if (map.size === 0) return undefined;
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function dimensionsFromPromptAssembly(metadata: RuntimePromptAssemblyInput): RuntimeMetricsDimensions | undefined {
  const record = objectRecord(metadata);
  if (!record) return undefined;
  const dimensions = compactDimensions({
    providerFamily: stringField(record.providerFamily), providerId: stringField(record.providerId), modelFamily: stringField(record.modelFamily),
    configuredModel: stringField(record.configuredModel), actualModel: stringField(record.actualModel), cacheStrategy: stringField(record.cacheStrategy),
    stablePrefixHash: stringField(record.stablePrefixHash), toolSchemaHash: stringField(record.toolSchemaHash), cacheKey: stringField(record.cacheKey)
  } as RuntimeMetricsDimensions);
  return Object.keys(dimensions).length > 0 ? dimensions : undefined;
}

export function compactDimensions(dimensions: RuntimeMetricsDimensions): RuntimeMetricsDimensions {
  return compactObject({
    ...(dimensions.providerFamily !== undefined ? { providerFamily: dimensions.providerFamily } : {}),
    ...(dimensions.providerId !== undefined ? { providerId: dimensions.providerId } : {}),
    ...(dimensions.modelFamily !== undefined ? { modelFamily: dimensions.modelFamily } : {}),
    ...(dimensions.configuredModel !== undefined ? { configuredModel: dimensions.configuredModel } : {}),
    ...(dimensions.actualModel !== undefined ? { actualModel: dimensions.actualModel } : {}),
    ...(dimensions.cacheStrategy !== undefined ? { cacheStrategy: dimensions.cacheStrategy } : {}),
    ...(dimensions.stablePrefixHash !== undefined ? { stablePrefixHash: dimensions.stablePrefixHash } : {}),
    ...(dimensions.toolSchemaHash !== undefined ? { toolSchemaHash: dimensions.toolSchemaHash } : {}),
    ...(dimensions.cacheKey !== undefined ? { cacheKey: dimensions.cacheKey } : {}),
  }) as RuntimeMetricsDimensions;
}

export function dimensionsKey(dimensions: RuntimeMetricsDimensions): string {
  return JSON.stringify(Object.entries(dimensions).filter(([, value]) => value !== undefined).sort(([left], [right]) => left.localeCompare(right)));
}

export function classifyToolOutcome(output: ToolOutput): { timeout: boolean; cancel: boolean } {
  const values = collectOutcomeValues(output.json);
  if (output.text) values.push(output.text);
  const text = values.join(" ");
  return { timeout: /\b(?:timed[-\s]?out|timeout)\b/i.test(text), cancel: /\b(?:cancelled|canceled|aborted|abort)\b/i.test(text) };
}

export function payloadSummary(value: unknown): RuntimePayloadSummary {
  const serialized = stableJson(value);
  const keys = topLevelKeys(value);
  return compactObject({ kind: "json", byteSize: Buffer.byteLength(serialized, "utf8"), sha256: createHash("sha256").update(serialized).digest("hex"), redacted: true, keys }) as unknown as RuntimePayloadSummary;
}

function stableJson(value: unknown): string { return JSON.stringify(normalizeJsonForHash(value)); }

function normalizeJsonForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJsonForHash);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, normalizeJsonForHash(item)]));
}

function topLevelKeys(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value).sort();
  return keys.length > 0 ? keys.slice(0, 24) : undefined;
}

export function rootSpanId(sessionId: string): string { return `conversation:${sessionId}`; }
export function messageSpanId(messageId: string): string { return `message:${messageId}`; }
export function toolSpanId(toolCallId: string): string { return `tool:${toolCallId}`; }

export function providerSpanId(diagnostic: ProviderDiagnostic): string {
  const providerId = diagnostic.providerId ?? "provider";
  const attempt = diagnostic.attempt ?? 1;
  const endpoint = diagnostic.endpoint ?? "stream";
  return `provider:${providerId}:${endpoint}:${attempt}`;
}

export function isShellToolName(toolName: string): boolean { return /^(?:shell|shell_command|command|exec|terminal)$/i.test(toolName); }

export function toolErrorMessage(result: ToolBatchResult): string {
  return firstStringValue(result.output.json) ?? result.output.text ?? `Tool failed: ${result.toolName}`;
}

function firstStringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) { for (const item of value) { const found = firstStringValue(item); if (found) return found; } return undefined; }
  const record = value as Record<string, unknown>;
  return firstStringValue(record.error) ?? firstStringValue(record.message) ?? firstStringValue(record.reason);
}

export function eventTimestamp(event: AgentEvent): string | undefined {
  return "timestamp" in event && typeof event.timestamp === "string" ? event.timestamp : undefined;
}

export function isoDurationMs(startedAt: string, endedAt: string): number | undefined {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return Math.max(0, end - start);
}

function ratePerSecond(count: number, elapsedMs: number): number | undefined {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return undefined;
  return count / (elapsedMs / 1000);
}

export function compactSpan(span: RuntimeSpanSummary): RuntimeSpanSummary { return compactObject(span as unknown as Record<string, unknown>) as unknown as RuntimeSpanSummary; }
export function compactError(error: RuntimeErrorSummary): RuntimeErrorSummary { return compactObject(error as unknown as Record<string, unknown>) as unknown as RuntimeErrorSummary; }

export function truncate(value: string, maxLength: number): string { return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`; }

function collectOutcomeValues(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(collectOutcomeValues);
  if (typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const directValues = [record.timedOut === true ? "timeout" : undefined, record.cancelled === true ? "cancelled" : undefined, record.canceled === true ? "canceled" : undefined, stringField(record.state), stringField(record.reason), stringField(record.signal), stringField(record.error), stringField(record.message)].filter((item): item is string => item !== undefined);
  return [...directValues, ...Object.values(record).flatMap(collectOutcomeValues)];
}

export function finiteNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
export function finiteNonNegativeNumber(value: unknown): number | undefined { const n = finiteNumber(value); return n !== undefined && n >= 0 ? n : undefined; }
export function stringField(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
export function objectRecord(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined; }

export function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

export function compactSnapshot(input: RuntimeMetricsSnapshot): RuntimeMetricsSnapshot {
  return compactObject(input as unknown as Record<string, unknown>) as unknown as RuntimeMetricsSnapshot;
}

export function errorSummary(sessionId: string | undefined, layer: RuntimeErrorLayer, message: string, timestamp?: string, context: Partial<RuntimeErrorSummary> = {}): RuntimeErrorSummary {
  return compactError({ layer, message: truncate(message, MAX_ERROR_MESSAGE_LENGTH), timestamp, traceId: sessionId, sessionId, ...context, ...(context.stack ? { stack: truncate(context.stack, MAX_ERROR_STACK_LENGTH) } : {}) } as RuntimeErrorSummary);
}

export function traceSummary(sessionId: string | undefined, startedAt: string | undefined, endedAt: string | undefined, spanOrder: RingBuffer<string>, spans: BoundedMap<string, RuntimeSpanSummary>, errors: RingBuffer<RuntimeErrorSummary>): RuntimeTraceSummary {
  const spanList = spanOrder.toArray().map((sid) => spans.get(sid)).filter((span): span is RuntimeSpanSummary => Boolean(span));
  return compactObject({ traceId: sessionId, sessionId, startedAt, endedAt, spanCount: spanList.length, errorCount: errors.size, spans: spanList.map((span) => compactSpan({ traceId: sessionId, sessionId, ...span } as RuntimeSpanSummary)), recentErrors: errors.toArray().map((err) => compactError({ traceId: sessionId, sessionId, ...err } as RuntimeErrorSummary)) } as unknown as Record<string, unknown>) as unknown as RuntimeTraceSummary;
}
