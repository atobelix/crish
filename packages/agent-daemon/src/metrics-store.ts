import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { errorMessage, isNodeError, fsyncPathAsync } from "@crish/shared-utils";
import type { AgentEvent } from "@crish/shared-types";
import {
  RuntimeMetricsCollector,
  cacheMetricsFromProviderUsage,
  type RuntimeMetricsDimensionSnapshot,
  type RuntimeMetricsDimensions,
  type RuntimeErrorSummary,
  type RuntimeMetricsSnapshot,
  type RuntimeStreamingMetricsSnapshot,
  type RuntimeSpanSummary,
  type RuntimeProviderUsageMetrics,
  type RuntimeToolNameMetricsSnapshot,
} from "@crish/agent-runtime";
import type {
  DaemonMetricsDiagnostic,
  DaemonMetricsQueryResult,
  DaemonMetricsRunRecord,
  DaemonMetricsSource,
  DaemonMetricsSummary,
} from "./types.js";

export const DAEMON_METRICS_STORE_VERSION = 1;
const MAX_MERGED_TRACE_SPANS = 96;
const MAX_MERGED_TRACE_ERRORS = 64;

export interface DaemonMetricsQuery {
  runId?: string;
  sessionId?: string;
  includeRuns?: boolean;
}

interface PersistedMetricsStoreFile {
  version: 1;
  updatedAt: string;
  runs: DaemonMetricsRunRecord[];
}

type PersistedMetricsRecord =
  | PersistedMetricsHeaderRecord
  | PersistedMetricsRunStartedRecord
  | PersistedMetricsRunLifecycleRecord
  | PersistedMetricsAgentEventRecord
  | PersistedMetricsSnapshotRecord;

interface PersistedMetricsHeaderRecord {
  type: "metrics-header";
  version: 1;
  createdAt: string;
}

interface PersistedMetricsRunStartedRecord {
  type: "run-started";
  version: 1;
  runId: string;
  sessionId: string;
  timestamp: string;
}

interface PersistedMetricsRunLifecycleRecord {
  type: "run-lifecycle";
  version: 1;
  runId: string;
  sessionId: string;
  timestamp: string;
  eventType: "run-cancel-requested" | "run-cancelled";
}

interface PersistedMetricsAgentEventRecord {
  type: "agent-event";
  version: 1;
  runId: string;
  sessionId: string;
  timestamp: string;
  event: AgentEvent;
}

interface PersistedMetricsSnapshotRecord {
  type: "snapshot";
  version: 1;
  updatedAt: string;
  runs: DaemonMetricsRunRecord[];
}

interface MutableRunMetrics {
  runId: string;
  sessionId: string;
  updatedAt: string;
  collector: RuntimeMetricsCollector;
  baseline?: RuntimeMetricsSnapshot;
  snapshot: RuntimeMetricsSnapshot;
  lifecycle: MutableRunLifecycleMetrics;
}

interface MutableRunLifecycleMetrics {
  cancelRequestedAt?: string;
  cancelRequestedCount: number;
  cancelObserved?: boolean;
  cancelLatencyMs?: number;
}

export class FileMetricsStore {
  private readonly runs = new Map<string, MutableRunMetrics>();
  private diagnostic: DaemonMetricsDiagnostic | undefined;
  private loaded = false;
  private headerWritten = false;
  private generation = 0;
  private badLineCount = 0;
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string) {}

  async restore(): Promise<void> {
    try {
      const text = await readFile(this.filePath, "utf8");
      if (looksLikeJsonDocument(text)) {
        try {
          this.restoreSnapshotFile(JSON.parse(text) as PersistedMetricsStoreFile);
        } catch {
          await this.restoreJsonl();
        }
      } else {
        await this.restoreJsonl();
      }
      this.loaded = true;
      if (this.badLineCount === 0) this.diagnostic = undefined;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.loaded = true;
        return;
      }
      this.recordDiagnostic("METRICS_STORE_RESTORE_FAILED", `Failed to restore daemon metrics store: ${errorMessage(error)}`, error);
    }
  }

  recordRunStarted(input: { runId: string; sessionId: string; timestamp?: string }): void {
    this.ensureLoaded();
    const timestamp = input.timestamp ?? new Date().toISOString();
    this.ensureRun(input.runId, input.sessionId, timestamp);
    void this.appendRecord({
      type: "run-started",
      version: DAEMON_METRICS_STORE_VERSION,
      runId: input.runId,
      sessionId: input.sessionId,
      timestamp,
    });
  }

  async recordRunLifecycle(input: {
    runId: string;
    sessionId: string;
    eventType: PersistedMetricsRunLifecycleRecord["eventType"];
    timestamp?: string;
  }): Promise<void> {
    this.ensureLoaded();
    const timestamp = input.timestamp ?? new Date().toISOString();
    const run = this.ensureRun(input.runId, input.sessionId, timestamp);
    applyRunLifecycle(run, input.eventType, timestamp);
    this.generation += 1;
    await this.appendRecord({
      type: "run-lifecycle",
      version: DAEMON_METRICS_STORE_VERSION,
      runId: input.runId,
      sessionId: input.sessionId,
      timestamp,
      eventType: input.eventType,
    });
  }

  async recordAgentEvent(input: { runId: string; sessionId: string; event: AgentEvent }): Promise<void> {
    this.ensureLoaded();
    const timestamp = eventTimestamp(input.event) ?? new Date().toISOString();
    const run = this.ensureRun(input.runId, input.sessionId, timestamp);
    run.collector.recordEvent(input.event);
    run.sessionId = input.sessionId;
    run.updatedAt = timestamp;
    run.snapshot = withRunLifecycleMetrics(
      withSnapshotSession(
      run.baseline ? mergeSnapshots([run.baseline, run.collector.snapshot()]) : run.collector.snapshot(),
      input.sessionId
      ),
      run.lifecycle
    );
    this.generation += 1;
    await this.appendRecord({
      type: "agent-event",
      version: DAEMON_METRICS_STORE_VERSION,
      runId: input.runId,
      sessionId: input.sessionId,
      timestamp,
      event: input.event,
    });
  }

  query(query: DaemonMetricsQuery = {}): DaemonMetricsQueryResult {
    this.ensureLoaded();
    const includeRuns = query.includeRuns ?? Boolean(query.runId || query.sessionId);
    const runs = this.filterRuns(query);
    const scope = query.runId ? "run" : query.sessionId ? "session" : "global";
    return {
      status: this.diagnostic ? "degraded" : "ok",
      query: {
        ...(query.runId !== undefined ? { runId: query.runId } : {}),
        ...(query.sessionId !== undefined ? { sessionId: query.sessionId } : {}),
        includeRuns,
      },
      source: {
        kind: "jsonl",
        path: this.filePath,
        generation: this.generation,
        status: this.diagnostic ? "degraded" : "ok",
        badLineCount: this.badLineCount,
      },
      summary: summarizeRuns(scope, runs),
      ...(includeRuns ? { runs: runs.map(toRunRecord) } : {}),
      ...(this.diagnostic ? { diagnostic: this.diagnostic } : {}),
    };
  }

  getDiagnostic(): DaemonMetricsDiagnostic | undefined {
    return this.diagnostic;
  }

  isEmpty(): boolean {
    return this.runs.size === 0;
  }

  async drain(): Promise<void> {
    await this.appendQueue;
  }

  async close(): Promise<void> {
    await this.drain();
  }

  async compact(): Promise<void> {
    this.ensureLoaded();
    const payload: PersistedMetricsSnapshotRecord = {
      type: "snapshot",
      version: DAEMON_METRICS_STORE_VERSION,
      updatedAt: new Date().toISOString(),
      runs: [...this.runs.values()].map(toRunRecord),
    };
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      const text = [headerRecordLine(), JSON.stringify(payload)].join("\n") + "\n";
      await writeFile(tmpPath, text, "utf8");
      await fsyncFile(tmpPath);
      await rename(tmpPath, this.filePath);
      this.headerWritten = true;
      this.generation += 1;
      this.badLineCount = 0;
      this.diagnostic = undefined;
    } catch (error) {
      this.recordDiagnostic("METRICS_STORE_WRITE_FAILED", `Failed to compact daemon metrics store: ${errorMessage(error)}`, error);
    }
  }

  private filterRuns(query: DaemonMetricsQuery): MutableRunMetrics[] {
    return [...this.runs.values()]
      .filter((run) => query.runId === undefined || run.runId === query.runId)
      .filter((run) => query.sessionId === undefined || run.sessionId === query.sessionId)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.runId.localeCompare(right.runId));
  }

  private ensureRun(runId: string, sessionId: string, timestamp: string): MutableRunMetrics {
    const existing = this.runs.get(runId);
    if (existing) return existing;
    const collector = new RuntimeMetricsCollector();
    const snapshot = withSnapshotSession(collector.snapshot(), sessionId);
    const run: MutableRunMetrics = {
      runId,
      sessionId,
      updatedAt: timestamp,
      collector,
      snapshot,
      lifecycle: createRunLifecycleMetrics(),
    };
    this.runs.set(runId, run);
    return run;
  }

  private async persist(): Promise<void> {
    await this.compact();
  }

  private restoreSnapshotFile(parsed: PersistedMetricsStoreFile): void {
    if (!isPersistedMetricsStoreFile(parsed)) {
      throw new Error("Invalid daemon metrics store shape");
    }
    this.runs.clear();
    for (const run of parsed.runs) {
      this.restoreRunSnapshot(run);
    }
    this.headerWritten = false;
    this.generation = parsed.runs.length;
    this.badLineCount = 0;
  }

  private async restoreJsonl(): Promise<void> {
    this.runs.clear();
    this.headerWritten = false;
    this.generation = 0;
    this.badLineCount = 0;
    let lineNumber = 0;
    const stream = createReadStream(this.filePath, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const rawLine of lines) {
      lineNumber += 1;
      const line = rawLine.trim();
      if (!line) continue;
      try {
        this.applyPersistedRecord(JSON.parse(line) as unknown);
      } catch (error) {
        this.badLineCount += 1;
        this.recordDiagnostic(
          "METRICS_STORE_BAD_LINE",
          `Ignored invalid metrics store line ${lineNumber}: ${errorMessage(error)}`,
          error
        );
      }
    }
    if (!this.headerWritten) {
      await this.appendRecord({
        type: "metrics-header",
        version: DAEMON_METRICS_STORE_VERSION,
        createdAt: new Date().toISOString(),
      });
    }
  }

  private applyPersistedRecord(value: unknown): void {
    const record = readPersistedRecord(value);
    switch (record.type) {
      case "metrics-header":
        this.headerWritten = true;
        break;
      case "snapshot":
        this.runs.clear();
        for (const run of record.runs) this.restoreRunSnapshot(run);
        this.generation += 1;
        break;
      case "run-started":
        this.ensureRun(record.runId, record.sessionId, record.timestamp);
        this.generation += 1;
        break;
      case "run-lifecycle":
        this.replayRunLifecycle(record);
        this.generation += 1;
        break;
      case "agent-event":
        this.replayAgentEvent(record);
        this.generation += 1;
        break;
    }
  }

  private restoreRunSnapshot(run: DaemonMetricsRunRecord): void {
    const collector = new RuntimeMetricsCollector();
    const snapshot = normalizeRuntimeMetricsSnapshot(run.snapshot);
    this.runs.set(run.runId, {
      runId: run.runId,
      sessionId: run.sessionId,
      updatedAt: run.updatedAt,
      collector,
      baseline: cloneSnapshot(snapshot),
      snapshot: cloneSnapshot(snapshot),
      lifecycle: lifecycleFromSnapshot(snapshot),
    });
  }

  private replayRunLifecycle(record: PersistedMetricsRunLifecycleRecord): void {
    const run = this.ensureRun(record.runId, record.sessionId, record.timestamp);
    applyRunLifecycle(run, record.eventType, record.timestamp);
  }

  private replayAgentEvent(record: PersistedMetricsAgentEventRecord): void {
    const run = this.ensureRun(record.runId, record.sessionId, record.timestamp);
    run.collector.recordEvent(record.event);
    run.sessionId = record.sessionId;
    run.updatedAt = record.timestamp;
    run.snapshot = withRunLifecycleMetrics(
      withSnapshotSession(
      run.baseline ? mergeSnapshots([run.baseline, run.collector.snapshot()]) : run.collector.snapshot(),
      record.sessionId
      ),
      run.lifecycle
    );
  }

  private appendRecord(record: PersistedMetricsRecord): Promise<void> {
    const write = this.appendQueue.then(() => this.writeRecord(record));
    this.appendQueue = write.catch(() => undefined);
    return write;
  }

  private async writeRecord(record: PersistedMetricsRecord): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      if (!this.headerWritten && record.type !== "metrics-header") {
        await appendFile(this.filePath, `${headerRecordLine()}\n`, "utf8");
        this.headerWritten = true;
      }
      await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
      await fsyncFile(this.filePath);
      this.diagnostic = undefined;
    } catch (error) {
      this.recordDiagnostic("METRICS_STORE_WRITE_FAILED", `Failed to persist daemon metrics store: ${errorMessage(error)}`, error);
    }
  }

  private recordDiagnostic(code: string, message: string, error: unknown): void {
    this.diagnostic = {
      code,
      message,
      updatedAt: new Date().toISOString(),
      path: this.filePath,
      ...(error instanceof Error && error.stack ? { detail: error.stack } : {}),
    };
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      this.loaded = true;
    }
  }
}

function summarizeRuns(scope: DaemonMetricsSummary["scope"], runs: readonly DaemonMetricsRunRecord[] | readonly MutableRunMetrics[]): DaemonMetricsSummary {
  const records = runs.map((run) => ("collector" in run ? toRunRecord(run) : run));
  return {
    scope,
    runCount: records.length,
    sessionCount: new Set(records.map((run) => run.sessionId)).size,
    snapshot: mergeSnapshots(records.map((run) => run.snapshot)),
  };
}

function mergeSnapshots(snapshots: readonly RuntimeMetricsSnapshot[]): RuntimeMetricsSnapshot {
  const providerUsage = emptyProviderUsage();
  const failures = {
    errorCount: 0,
    runtimeErrorCount: 0,
    agentErrorCount: 0,
    providerErrorCount: 0,
    contextCompressionErrorCount: 0,
    timeoutCount: 0,
    cancelCount: 0,
  };
  const dimensions = new Map<string, RuntimeMetricsDimensionSnapshot>();
  const spans: RuntimeSpanSummary[] = [];
  const recentErrors: RuntimeErrorSummary[] = [];
  const toolDurations: number[] = [];
  const providerLatencies: number[] = [];
  const streaming = createMergedStreamingMetrics();
  const toolByName = new Map<string, { callCount: number; errorCount: number; timeoutCount: number; cancelCount: number; durations: number[] }>();
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  let eventCount = 0;
  let turnCount = 0;
  let latestDimensions: RuntimeMetricsDimensions | undefined;

  for (const snapshot of snapshots) {
    eventCount += snapshot.eventCount;
    turnCount += snapshot.turnCount;
    addProviderUsage(providerUsage, snapshot.providerUsage);
    appendDurationSummary(providerLatencies, snapshot.providerLatencyMs);
    addFailures(failures, snapshot.failures);
    addStreamingMetrics(streaming, snapshot.streaming);
    if (snapshot.trace) {
      spans.push(...snapshot.trace.spans);
      recentErrors.push(...snapshot.trace.recentErrors);
    }
    if (snapshot.startedAt && (!startedAt || snapshot.startedAt < startedAt)) startedAt = snapshot.startedAt;
    if (snapshot.endedAt && (!endedAt || snapshot.endedAt > endedAt)) endedAt = snapshot.endedAt;
    if (snapshot.latestDimensions) latestDimensions = snapshot.latestDimensions;
    appendDurationSummary(toolDurations, snapshot.tools.durationMs);
    for (const [toolName, metrics] of Object.entries(snapshot.tools.byName)) {
      const target = toolByName.get(toolName) ?? { callCount: 0, errorCount: 0, timeoutCount: 0, cancelCount: 0, durations: [] };
      target.callCount += metrics.callCount;
      target.errorCount += metrics.errorCount;
      target.timeoutCount += metrics.timeoutCount;
      target.cancelCount += metrics.cancelCount;
      appendDurationSummary(target.durations, metrics.durationMs);
      toolByName.set(toolName, target);
    }
    for (const dimension of snapshot.dimensions) {
      const key = dimensionsKey(dimension);
      const existing = dimensions.get(key);
      if (existing) {
        existing.promptAssemblyCount += dimension.promptAssemblyCount;
        addProviderUsage(existing.providerUsage, dimension.providerUsage);
        existing.cache = cacheMetricsFromProviderUsage(existing.providerUsage);
        existing.providerLatencyMs = durationMetricsFromSummaries([existing.providerLatencyMs, dimension.providerLatencyMs]);
      } else {
        const providerUsage = { ...dimension.providerUsage };
        dimensions.set(key, {
          ...dimension,
          providerUsage,
          cache: cacheMetricsFromProviderUsage(providerUsage),
          providerLatencyMs: { ...dimension.providerLatencyMs },
        });
      }
    }
  }

  const byName = Object.fromEntries(
    [...toolByName.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([toolName, metrics]) => [
      toolName,
      {
        toolName,
        callCount: metrics.callCount,
        errorCount: metrics.errorCount,
        errorRate: errorRate(metrics.callCount, metrics.errorCount),
        timeoutCount: metrics.timeoutCount,
        timeoutRate: errorRate(metrics.callCount, metrics.timeoutCount),
        cancelCount: metrics.cancelCount,
        cancelRate: errorRate(metrics.callCount, metrics.cancelCount),
        durationMs: durationMetrics(metrics.durations),
      } satisfies RuntimeToolNameMetricsSnapshot,
    ])
  );

  const toolCallCount = [...toolByName.values()].reduce((sum, metrics) => sum + metrics.callCount, 0);
  const toolErrorCount = [...toolByName.values()].reduce((sum, metrics) => sum + metrics.errorCount, 0);
  const toolTimeoutCount = [...toolByName.values()].reduce((sum, metrics) => sum + metrics.timeoutCount, 0);
  const toolCancelCount = [...toolByName.values()].reduce((sum, metrics) => sum + metrics.cancelCount, 0);

  return compactSnapshot({
    startedAt,
    endedAt,
    eventCount,
    turnCount,
    tools: {
      callCount: toolCallCount,
      errorCount: toolErrorCount,
      errorRate: errorRate(toolCallCount, toolErrorCount),
      timeoutCount: toolTimeoutCount,
      timeoutRate: errorRate(toolCallCount, toolTimeoutCount),
      cancelCount: toolCancelCount,
      cancelRate: errorRate(toolCallCount, toolCancelCount),
      durationMs: durationMetrics(toolDurations),
      byName,
    },
    providerUsage,
    providerLatencyMs: durationMetrics(providerLatencies),
    streaming: snapshotMergedStreamingMetrics(streaming, startedAt, endedAt, eventCount),
    cache: cacheMetricsFromProviderUsage(providerUsage),
    failures,
    trace: compactObject({
      startedAt,
      endedAt,
      spanCount: spans.length,
      errorCount: recentErrors.length,
      spans: spans
        .sort((left, right) => (left.startedAt ?? "").localeCompare(right.startedAt ?? "") || left.spanId.localeCompare(right.spanId))
        .slice(-MAX_MERGED_TRACE_SPANS),
      recentErrors: recentErrors
        .sort((left, right) => (left.timestamp ?? "").localeCompare(right.timestamp ?? ""))
        .slice(-MAX_MERGED_TRACE_ERRORS),
    }) as RuntimeMetricsSnapshot["trace"],
    latestDimensions,
    dimensions: [...dimensions.values()],
  });
}

function appendDurationSummary(target: number[], summary: RuntimeMetricsSnapshot["tools"]["durationMs"]): void {
  if (summary.count <= 0) return;
  for (const value of [summary.min, summary.p50, summary.p95, summary.p99, summary.max]) {
    if (typeof value === "number" && Number.isFinite(value)) target.push(value);
  }
}

function durationMetricsFromSummaries(summaries: readonly RuntimeMetricsSnapshot["tools"]["durationMs"][]): RuntimeMetricsSnapshot["tools"]["durationMs"] {
  const values: number[] = [];
  for (const summary of summaries) appendDurationSummary(values, summary);
  return durationMetrics(values);
}

function durationMetrics(values: readonly number[]): RuntimeMetricsSnapshot["tools"]["durationMs"] {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((left, right) => left - right);
  if (sorted.length === 0) return { count: 0 };
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

function percentile(sorted: readonly number[], percentileValue: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const rank = (percentileValue / 100) * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sorted[lowerIndex]!;
  const upper = sorted[upperIndex]!;
  return lowerIndex === upperIndex ? lower : lower + (upper - lower) * (rank - lowerIndex);
}

function emptyProviderUsage(): RuntimeProviderUsageMetrics {
  return {
    sampleCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
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

function addFailures(target: RuntimeMetricsSnapshot["failures"], failures: RuntimeMetricsSnapshot["failures"]): void {
  target.errorCount += failures.errorCount;
  target.runtimeErrorCount += failures.runtimeErrorCount;
  target.agentErrorCount += failures.agentErrorCount;
  target.providerErrorCount += failures.providerErrorCount;
  target.contextCompressionErrorCount += failures.contextCompressionErrorCount;
  target.timeoutCount += failures.timeoutCount;
  target.cancelCount += failures.cancelCount;
}

function createMergedStreamingMetrics(): Required<
  Pick<RuntimeStreamingMetricsSnapshot, "textDeltaCount" | "providerDiagnosticCount">
> & {
  firstTextDeltaLatencies: number[];
  firstProviderResponseLatencies: number[];
  providerStreamDurations: number[];
  cancelRequestedCount: number;
  cancelObserved: boolean;
  cancelLatencies: number[];
} {
  return {
    textDeltaCount: 0,
    providerDiagnosticCount: 0,
    firstTextDeltaLatencies: [],
    firstProviderResponseLatencies: [],
    providerStreamDurations: [],
    cancelRequestedCount: 0,
    cancelObserved: false,
    cancelLatencies: [],
  };
}

function addStreamingMetrics(target: ReturnType<typeof createMergedStreamingMetrics>, snapshot: RuntimeStreamingMetricsSnapshot | undefined): void {
  if (!snapshot) return;
  target.textDeltaCount += snapshot.textDeltaCount;
  target.providerDiagnosticCount += snapshot.providerDiagnosticCount;
  if (typeof snapshot.firstTextDeltaLatencyMs === "number") target.firstTextDeltaLatencies.push(snapshot.firstTextDeltaLatencyMs);
  if (typeof snapshot.firstProviderResponseLatencyMs === "number") {
    target.firstProviderResponseLatencies.push(snapshot.firstProviderResponseLatencyMs);
  }
  if (typeof snapshot.providerStreamDurationMs === "number") target.providerStreamDurations.push(snapshot.providerStreamDurationMs);
  target.cancelRequestedCount += snapshot.cancelRequestedCount ?? 0;
  target.cancelObserved ||= snapshot.cancelObserved === true;
  if (typeof snapshot.cancelLatencyMs === "number") target.cancelLatencies.push(snapshot.cancelLatencyMs);
}

function snapshotMergedStreamingMetrics(
  metrics: ReturnType<typeof createMergedStreamingMetrics>,
  startedAt: string | undefined,
  endedAt: string | undefined,
  eventCount: number
): RuntimeStreamingMetricsSnapshot {
  const totalMs = startedAt && endedAt ? isoDurationMs(startedAt, endedAt) : undefined;
  return compactObject({
    textDeltaCount: metrics.textDeltaCount,
    providerDiagnosticCount: metrics.providerDiagnosticCount,
    firstTextDeltaLatencyMs: minNumber(metrics.firstTextDeltaLatencies),
    firstProviderResponseLatencyMs: minNumber(metrics.firstProviderResponseLatencies),
    providerStreamDurationMs: maxNumber(metrics.providerStreamDurations),
    tokensPerSecond: totalMs !== undefined ? ratePerSecond(metrics.textDeltaCount, totalMs) : undefined,
    eventsPerSecond: totalMs !== undefined ? ratePerSecond(eventCount, totalMs) : undefined,
    cancelRequestedCount: metrics.cancelRequestedCount || undefined,
    cancelObserved: metrics.cancelObserved || undefined,
    cancelLatencyMs: maxNumber(metrics.cancelLatencies),
  }) as unknown as RuntimeStreamingMetricsSnapshot;
}

function toRunRecord(run: MutableRunMetrics): DaemonMetricsRunRecord {
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    updatedAt: run.updatedAt,
    snapshot: cloneSnapshot(withRunLifecycleMetrics(run.snapshot, run.lifecycle)),
  };
}

function withSnapshotSession(snapshot: RuntimeMetricsSnapshot, sessionId: string): RuntimeMetricsSnapshot {
  return { ...snapshot, sessionId };
}

function createRunLifecycleMetrics(): MutableRunLifecycleMetrics {
  return {
    cancelRequestedCount: 0,
  };
}

function lifecycleFromSnapshot(snapshot: RuntimeMetricsSnapshot): MutableRunLifecycleMetrics {
  return {
    cancelRequestedCount: snapshot.streaming?.cancelRequestedCount ?? 0,
    cancelObserved: snapshot.streaming?.cancelObserved,
    cancelLatencyMs: snapshot.streaming?.cancelLatencyMs,
  };
}

function applyRunLifecycle(run: MutableRunMetrics, eventType: PersistedMetricsRunLifecycleRecord["eventType"], timestamp: string): void {
  run.updatedAt = timestamp;
  if (eventType === "run-cancel-requested") {
    run.lifecycle.cancelRequestedAt = timestamp;
    run.lifecycle.cancelRequestedCount += 1;
  } else {
    run.lifecycle.cancelObserved = true;
    if (run.lifecycle.cancelRequestedAt) {
      run.lifecycle.cancelLatencyMs = isoDurationMs(run.lifecycle.cancelRequestedAt, timestamp);
    }
  }
  run.snapshot = withRunLifecycleMetrics(run.snapshot, run.lifecycle);
}

function withRunLifecycleMetrics(snapshot: RuntimeMetricsSnapshot, lifecycle: MutableRunLifecycleMetrics): RuntimeMetricsSnapshot {
  return {
    ...snapshot,
    streaming: compactObject({
      ...snapshot.streaming,
      textDeltaCount: snapshot.streaming?.textDeltaCount ?? 0,
      providerDiagnosticCount: snapshot.streaming?.providerDiagnosticCount ?? 0,
      cancelRequestedCount: lifecycle.cancelRequestedCount || snapshot.streaming?.cancelRequestedCount,
      cancelObserved: lifecycle.cancelObserved ?? snapshot.streaming?.cancelObserved,
      cancelLatencyMs: lifecycle.cancelLatencyMs ?? snapshot.streaming?.cancelLatencyMs,
    }) as unknown as RuntimeStreamingMetricsSnapshot,
  };
}

function cloneSnapshot(snapshot: RuntimeMetricsSnapshot): RuntimeMetricsSnapshot {
  return normalizeRuntimeMetricsSnapshot(JSON.parse(JSON.stringify(snapshot)) as RuntimeMetricsSnapshot);
}

function normalizeRuntimeMetricsSnapshot(snapshot: RuntimeMetricsSnapshot): RuntimeMetricsSnapshot {
  const providerUsage = snapshot.providerUsage ?? emptyProviderUsage();
  return {
    ...snapshot,
    providerUsage,
    cache: snapshot.cache ?? cacheMetricsFromProviderUsage(providerUsage),
    dimensions: (snapshot.dimensions ?? []).map((dimension) => {
      const dimensionUsage = dimension.providerUsage ?? emptyProviderUsage();
      return {
        ...dimension,
        providerUsage: dimensionUsage,
        cache: dimension.cache ?? cacheMetricsFromProviderUsage(dimensionUsage),
      };
    }),
  };
}

function eventTimestamp(event: AgentEvent): string | undefined {
  return "timestamp" in event && typeof event.timestamp === "string" ? event.timestamp : undefined;
}

function isPersistedMetricsStoreFile(value: unknown): value is PersistedMetricsStoreFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === DAEMON_METRICS_STORE_VERSION && Array.isArray(record.runs);
}

function readPersistedRecord(value: unknown): PersistedMetricsRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Metrics record must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== DAEMON_METRICS_STORE_VERSION) {
    throw new Error("Unsupported metrics record version");
  }
  if (record.type === "metrics-header") {
    if (typeof record.createdAt !== "string") throw new Error("Metrics header createdAt is required");
    return record as unknown as PersistedMetricsHeaderRecord;
  }
  if (record.type === "snapshot") {
    if (typeof record.updatedAt !== "string" || !Array.isArray(record.runs)) throw new Error("Invalid metrics snapshot record");
    return record as unknown as PersistedMetricsSnapshotRecord;
  }
  if (record.type === "run-started") {
    if (typeof record.runId !== "string" || typeof record.sessionId !== "string" || typeof record.timestamp !== "string") {
      throw new Error("Invalid metrics run-started record");
    }
    return record as unknown as PersistedMetricsRunStartedRecord;
  }
  if (record.type === "run-lifecycle") {
    if (
      typeof record.runId !== "string" ||
      typeof record.sessionId !== "string" ||
      typeof record.timestamp !== "string" ||
      (record.eventType !== "run-cancel-requested" && record.eventType !== "run-cancelled")
    ) {
      throw new Error("Invalid metrics run-lifecycle record");
    }
    return record as unknown as PersistedMetricsRunLifecycleRecord;
  }
  if (record.type === "agent-event") {
    if (
      typeof record.runId !== "string" ||
      typeof record.sessionId !== "string" ||
      typeof record.timestamp !== "string" ||
      !record.event ||
      typeof record.event !== "object" ||
      Array.isArray(record.event)
    ) {
      throw new Error("Invalid metrics agent-event record");
    }
    return record as unknown as PersistedMetricsAgentEventRecord;
  }
  throw new Error("Unknown metrics record type");
}

function looksLikeJsonDocument(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("{");
}

function headerRecordLine(): string {
  return JSON.stringify({
    type: "metrics-header",
    version: DAEMON_METRICS_STORE_VERSION,
    createdAt: new Date().toISOString(),
  } satisfies PersistedMetricsHeaderRecord);
}

async function fsyncFile(filePath: string): Promise<void> {
  await fsyncPathAsync(filePath, "r+");
}

function dimensionsKey(dimensions: RuntimeMetricsDimensions): string {
  return JSON.stringify(
    Object.entries(dimensions)
      .filter(([key, value]) => key !== "promptAssemblyCount" && key !== "providerUsage" && key !== "providerLatencyMs" && value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function errorRate(callCount: number, errorCount: number): number {
  return callCount === 0 ? 0 : errorCount / callCount;
}

function compactSnapshot(snapshot: RuntimeMetricsSnapshot): RuntimeMetricsSnapshot {
  return Object.fromEntries(
    Object.entries(snapshot as unknown as Record<string, unknown>).filter(([, value]) => value !== undefined)
  ) as unknown as RuntimeMetricsSnapshot;
}

function compactObject<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

function minNumber(values: readonly number[]): number | undefined {
  const clean = values.filter((value) => Number.isFinite(value) && value >= 0);
  return clean.length > 0 ? Math.min(...clean) : undefined;
}

function maxNumber(values: readonly number[]): number | undefined {
  const clean = values.filter((value) => Number.isFinite(value) && value >= 0);
  return clean.length > 0 ? Math.max(...clean) : undefined;
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



