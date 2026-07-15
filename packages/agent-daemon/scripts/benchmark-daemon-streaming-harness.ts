import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import WebSocket, { type RawData } from "ws";
import { DaemonServer } from "../src/server.js";
import type {
  AgentProvider,
  AgentProviderRequest,
  ProviderStreamEvent,
} from "@crish/agent-runtime";

interface BenchmarkSample {
  index: number;
  stream: StreamMetrics;
  cancel: CancelMetrics;
}

interface StreamMetrics {
  firstTokenMs: number;
  totalMs: number;
  tokenCount: number;
  eventCount: number;
  tokensPerSecond: number;
  eventsPerSecond: number;
}

interface CancelMetrics {
  cancelLatencyMs: number;
  abortObserved: boolean;
  tokensBeforeCancel: number;
  settled: boolean;
  terminalEvent: string;
}

class PacedTokenProvider implements AgentProvider {
  readonly id = "benchmark-paced-provider";
  abortObserved = false;

  constructor(
    private readonly options: {
      tokens: string[];
      firstDelayMs: number;
      tokenDelayMs: number;
    }
  ) {}

  async *stream(request: AgentProviderRequest): AsyncIterable<ProviderStreamEvent> {
    let chunks = 0;
    request.signal.addEventListener(
      "abort",
      () => {
        this.abortObserved = true;
      },
      { once: true }
    );

    await sleep(this.options.firstDelayMs, request.signal);
    yield {
      type: "provider-diagnostic",
      diagnostic: {
        phase: "response-start",
        providerId: this.id,
        endpoint: "benchmark-stream",
        elapsedMs: this.options.firstDelayMs,
      },
    };
    for (const token of this.options.tokens) {
      if (request.signal.aborted) return;
      chunks += 1;
      yield { type: "text-delta", text: token };
      await sleep(this.options.tokenDelayMs, request.signal);
    }
    yield {
      type: "provider-diagnostic",
      diagnostic: {
        phase: "stream-end",
        providerId: this.id,
        endpoint: "benchmark-stream",
        elapsedMs: this.options.firstDelayMs + this.options.tokenDelayMs * chunks,
        chunks,
      },
    };
    yield { type: "stop", reason: "stop" };
  }
}

const args = parseArgs(process.argv.slice(2));
const iterations = positiveInteger(args.iterations ?? args.i, 3, "iterations");
const tokenCount = positiveInteger(args.tokens ?? args.tokenCount, 64, "tokens");
const firstDelayMs = nonNegativeInteger(args.firstDelayMs, 5, "firstDelayMs");
const tokenDelayMs = nonNegativeInteger(args.tokenDelayMs, 1, "tokenDelayMs");
const cancelTokenDelayMs = nonNegativeInteger(args.cancelTokenDelayMs, 10, "cancelTokenDelayMs");
const cancelAfterTokens = positiveInteger(args.cancelAfterTokens, 3, "cancelAfterTokens");
const timeoutMs = positiveInteger(args.timeoutMs ?? args.timeout, 10_000, "timeoutMs");
const keepLogs = Boolean(args.keepLogs);

const samples: BenchmarkSample[] = [];
const eventDir = await mkdtemp(join(tmpdir(), "conex-daemon-stream-bench-"));
const providers = new Map<string, PacedTokenProvider>();
const originalConsoleLog = console.log;
let server: DaemonServer | undefined;

try {
  console.log = (...values: unknown[]) => {
    console.error(...values);
  };
  server = new DaemonServer({ port: 0, sessionEventLogDir: eventDir });
  server.setProviderFactory((runId) => {
    const provider = providers.get(runId);
    if (!provider) throw new Error(`No benchmark provider registered for run ${runId}`);
    return provider;
  });
  server.setToolFactory(() => []);
  const port = await server.start();
  const ws = await openClient(port);

  for (let index = 0; index < iterations; index++) {
    samples.push(await runSample({ index, ws, providers }));
  }

  ws.close(1000, "benchmark complete");
} finally {
  await server?.stop().catch(() => undefined);
  console.log = originalConsoleLog;
  if (!keepLogs) {
    await rm(eventDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const summary = {
  benchmark: "daemon-streaming",
  runtime: detectRuntime(),
  iterations,
  tokenCount,
  firstDelayMs,
  tokenDelayMs,
  cancelTokenDelayMs,
  cancelAfterTokens,
  eventDir: keepLogs ? eventDir : undefined,
  samples,
  metrics: {
    firstTokenMs: summarize(samples.map((sample) => sample.stream.firstTokenMs)),
    tokensPerSecond: summarize(samples.map((sample) => sample.stream.tokensPerSecond)),
    eventsPerSecond: summarize(samples.map((sample) => sample.stream.eventsPerSecond)),
    totalMs: summarize(samples.map((sample) => sample.stream.totalMs)),
    cancelLatencyMs: summarize(samples.map((sample) => sample.cancel.cancelLatencyMs)),
    cancelSettledCount: samples.filter((sample) => sample.cancel.settled && sample.cancel.abortObserved).length,
  },
};

console.log(JSON.stringify(summary, null, 2));

async function runSample(input: {
  index: number;
  ws: WebSocket;
  providers: Map<string, PacedTokenProvider>;
}): Promise<BenchmarkSample> {
  const streamRunId = `bench_stream_${input.index}_${Date.now()}`;
  const streamProvider = new PacedTokenProvider({
    tokens: createTokens(tokenCount, "s"),
    firstDelayMs,
    tokenDelayMs,
  });
  input.providers.set(streamRunId, streamProvider);
  const stream = await measureCompletedStream(input.ws, streamRunId);
  input.providers.delete(streamRunId);

  const cancelRunId = `bench_cancel_${input.index}_${Date.now()}`;
  const cancelProvider = new PacedTokenProvider({
    tokens: createTokens(Math.max(tokenCount * 4, cancelAfterTokens + 8), "c"),
    firstDelayMs,
    tokenDelayMs: cancelTokenDelayMs,
  });
  input.providers.set(cancelRunId, cancelProvider);
  const cancel = await measureCancelledStream(input.ws, cancelRunId, cancelProvider);
  input.providers.delete(cancelRunId);

  return {
    index: input.index,
    stream,
    cancel,
  };
}

async function measureCompletedStream(ws: WebSocket, runId: string): Promise<StreamMetrics> {
  const startedAt = performance.now();
  ws.send(
    JSON.stringify({
      type: "run-task",
      runId,
      sessionId: `${runId}_session`,
      prompt: "stream benchmark",
    })
  );

  const messages = await withTimeout(
    collectMessages(ws, (message) => message.type === "event" && message.runId === runId && message.event?.type === "agent-end"),
    timeoutMs,
    `completed stream ${runId}`
  );
  const totalMs = performance.now() - startedAt;
  const textDeltas = messages.filter((message) => message.runId === runId && isTextDeltaMessage(message));
  const firstTokenMs = textDeltas[0] ? textDeltas[0].receivedAt - startedAt : Number.NaN;

  return {
    firstTokenMs: round(firstTokenMs),
    totalMs: round(totalMs),
    tokenCount: textDeltas.length,
    eventCount: messages.filter((message) => message.type === "event" && message.runId === runId).length,
    tokensPerSecond: rate(textDeltas.length, totalMs),
    eventsPerSecond: rate(messages.length, totalMs),
  };
}

async function measureCancelledStream(
  ws: WebSocket,
  runId: string,
  provider: PacedTokenProvider
): Promise<CancelMetrics> {
  ws.send(
    JSON.stringify({
      type: "run-task",
      runId,
      sessionId: `${runId}_session`,
      prompt: "stream benchmark cancel",
    })
  );

  const preCancelMessages = await withTimeout(
    collectMessages(ws, (message, messages) => {
      return messages.filter((candidate) => candidate.runId === runId && isTextDeltaMessage(candidate)).length >= cancelAfterTokens;
    }),
    timeoutMs,
    `pre-cancel tokens ${runId}`
  );
  const tokensBeforeCancel = preCancelMessages.filter((message) => message.runId === runId && isTextDeltaMessage(message)).length;
  const cancelStartedAt = performance.now();
  ws.send(JSON.stringify({ type: "cancel-run", runId }));

  const runEvents = await withTimeout(
    waitForRunEvent(runId, "run-cancelled"),
    timeoutMs,
    `cancel settled ${runId}`
  );
  const cancelLatencyMs = performance.now() - cancelStartedAt;
  const terminalEvent = runEvents.find((event) => event.type === "run-cancelled")?.type ?? "missing";

  return {
    cancelLatencyMs: round(cancelLatencyMs),
    abortObserved: provider.abortObserved,
    tokensBeforeCancel,
    settled: terminalEvent === "run-cancelled",
    terminalEvent,
  };
}

async function waitForRunEvent(runId: string, eventType: string): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await server!.readRunEvents(runId);
    if (events.some((event) => event.type === eventType)) return events;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${eventType} on ${runId}`);
}

async function openClient(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

async function collectMessages(
  ws: WebSocket,
  done: (message: any, messages: any[]) => boolean
): Promise<any[]> {
  const messages: any[] = [];
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    const onMessage = (data: RawData) => {
      const message = JSON.parse(data.toString());
      message.receivedAt = performance.now();
      messages.push(message);
      if (done(message, messages)) {
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`WebSocket closed before benchmark completed (code=${code}, reason=${reason.toString("utf8")})`));
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.on("close", onClose);
  });
  return messages;
}

function isTextDeltaMessage(message: any): boolean {
  return (
    message.type === "event" &&
    message.event?.type === "message-delta" &&
    message.event.block?.type === "text"
  );
}

function createTokens(count: number, prefix: string): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index} `);
}

function rate(count: number, elapsedMs: number): number {
  return round(count / Math.max(elapsedMs / 1000, 0.001));
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return;
  await new Promise<void>((resolve) => {
    let timeout: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => cleanup();
    timeout = setTimeout(cleanup, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) continue;
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function positiveInteger(value: string | boolean | undefined, fallback: number, label: string): number {
  const parsed = value === undefined || typeof value === "boolean" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value: string | boolean | undefined, fallback: number, label: string): number {
  const parsed = value === undefined || typeof value === "boolean" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function summarize(values: number[]) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (clean.length === 0) return undefined;
  return {
    min: round(clean[0]!),
    p50: percentile(clean, 0.5),
    p95: percentile(clean, 0.95),
    max: round(clean[clean.length - 1]!),
    mean: round(clean.reduce((sum, value) => sum + value, 0) / clean.length),
  };
}

function percentile(values: number[], rank: number): number {
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * rank) - 1));
  return round(values[index]!);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function detectRuntime(): string {
  return typeof (globalThis as { Bun?: unknown }).Bun === "object" ? "bun" : "node";
}
