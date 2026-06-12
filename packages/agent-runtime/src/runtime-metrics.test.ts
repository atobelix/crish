import { describe, expect, it } from "vitest";
import {
  calculateRuntimeMetricPercentile,
  collectRuntimeMetricsSnapshot,
  createTextMessage,
  RuntimeMetricsCollector,
} from ".";
import type { AgentEvent, JsonObject, ToolBatchResult } from "@crish/shared-types";

const timestamp = "2026-06-08T00:00:00.000Z";

function toolResult(input: Partial<ToolBatchResult> & { id: string; toolName: string }): ToolBatchResult {
  return {
    id: input.id,
    toolName: input.toolName,
    output: input.output ?? { text: "ok" },
    isError: input.isError ?? false,
    durationMs: input.durationMs ?? 0
  };
}

function toolEnd(result: ToolBatchResult): Extract<AgentEvent, { type: "tool-end" }> {
  return {
    type: "tool-end",
    sessionId: "session-1",
    batchId: "batch-1",
    result,
    timestamp
  };
}

function assistantEnd(metadata: JsonObject): Extract<AgentEvent, { type: "message-end" }> {
  return {
    type: "message-end",
    sessionId: "session-1",
    message: createTextMessage("assistant", "done", metadata)
  };
}

describe("RuntimeMetrics", () => {
  it("calculates interpolated percentiles", () => {
    expect(calculateRuntimeMetricPercentile([100, 200, 300, 400, 500], 50)).toBe(300);
    expect(calculateRuntimeMetricPercentile([100, 200, 300, 400, 500], 95)).toBe(480);
    expect(calculateRuntimeMetricPercentile([100, 200, 300, 400, 500], 99)).toBe(496);
    expect(calculateRuntimeMetricPercentile([], 95)).toBeUndefined();
  });

  it("aggregates tool duration percentiles", () => {
    const snapshot = collectRuntimeMetricsSnapshot([
      toolEnd(toolResult({ id: "call-1", toolName: "shell", durationMs: 100 })),
      toolEnd(toolResult({ id: "call-2", toolName: "shell", durationMs: 200 })),
      toolEnd(toolResult({ id: "call-3", toolName: "shell", durationMs: 300 })),
      toolEnd(toolResult({ id: "call-4", toolName: "shell", durationMs: 400 })),
      toolEnd(toolResult({ id: "call-5", toolName: "shell", durationMs: 500 }))
    ]);

    expect(snapshot.tools.durationMs).toMatchObject({
      count: 5,
      min: 100,
      max: 500,
      p50: 300,
      p95: 480,
      p99: 496
    });
    expect(snapshot.tools.byName.shell.durationMs.p95).toBe(480);
  });

  it("calculates tool error rate and outcome counts from tool-end facts", () => {
    const snapshot = collectRuntimeMetricsSnapshot([
      toolEnd(toolResult({ id: "call-1", toolName: "shell", isError: false, durationMs: 10 })),
      toolEnd(
        toolResult({
          id: "call-2",
          toolName: "shell",
          isError: true,
          durationMs: 20,
          output: { text: "Command timed out", json: { timedOut: true } }
        })
      ),
      toolEnd(
        toolResult({
          id: "call-3",
          toolName: "read_file",
          isError: true,
          durationMs: 30,
          output: { text: "aborted by caller", json: { cancelled: true } }
        })
      )
    ]);

    expect(snapshot.tools.callCount).toBe(3);
    expect(snapshot.tools.errorCount).toBe(2);
    expect(snapshot.tools.errorRate).toBeCloseTo(2 / 3);
    expect(snapshot.tools.timeoutCount).toBe(1);
    expect(snapshot.tools.cancelCount).toBe(1);
    expect(snapshot.tools.byName.shell.errorRate).toBeCloseTo(1 / 2);
    expect(snapshot.failures.errorCount).toBe(2);
    expect(snapshot.failures.timeoutCount).toBe(1);
    expect(snapshot.failures.cancelCount).toBe(1);
  });

  it("builds privacy-friendly trace spans and recent errors", () => {
    const snapshot = collectRuntimeMetricsSnapshot([
      { type: "agent-start", sessionId: "session-1", timestamp },
      {
        type: "message-start",
        sessionId: "session-1",
        message: createTextMessage("assistant", "", { id: "ignored" })
      },
      {
        type: "provider-diagnostic",
        sessionId: "session-1",
        timestamp,
        diagnostic: {
          phase: "request-error",
          providerId: "flowbit",
          endpoint: "responses",
          attempt: 1,
          elapsedMs: 250,
          status: 429,
          errorKind: "rate-limit",
          reason: "rate limited"
        }
      },
      {
        type: "tool-start",
        sessionId: "session-1",
        batchId: "batch-1",
        timestamp,
        call: {
          id: "call-1",
          toolName: "shell_command",
          summary: "run command",
          input: { command: "secret command text" },
          category: "terminal",
          concurrency: "sequential"
        }
      },
      toolEnd(
        toolResult({
          id: "call-1",
          toolName: "shell_command",
          isError: true,
          durationMs: 75,
          output: { text: "Command timed out", json: { timedOut: true, stderr: "private stderr" } }
        })
      )
    ]);

    expect(snapshot.trace?.traceId).toBe("session-1");
    expect(snapshot.trace?.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "conversation", spanId: "conversation:session-1" }),
        expect.objectContaining({
          kind: "model-stream",
          providerId: "flowbit",
          status: "error",
          error: expect.objectContaining({ layer: "provider", code: "rate-limit" })
        }),
        expect.objectContaining({
          kind: "shell-command",
          toolCallId: "call-1",
          status: "timeout",
          input: expect.objectContaining({
            redacted: true,
            keys: ["command"]
          }),
          output: expect.objectContaining({
            redacted: true,
            keys: ["json", "text"]
          })
        })
      ])
    );
    expect(JSON.stringify(snapshot.trace)).not.toContain("secret command text");
    expect(JSON.stringify(snapshot.trace)).not.toContain("private stderr");
    expect(snapshot.trace?.recentErrors).toHaveLength(2);
  });

  it("records streaming first text delta, provider latency, and throughput metrics", () => {
    const snapshot = collectRuntimeMetricsSnapshot([
      { type: "agent-start", sessionId: "session-1", timestamp: "2026-06-08T00:00:00.000Z" },
      {
        type: "provider-diagnostic",
        sessionId: "session-1",
        timestamp: "2026-06-08T00:00:00.020Z",
        diagnostic: {
          phase: "response-start",
          providerId: "flowbit",
          endpoint: "responses",
          elapsedMs: 20,
          configuredModel: "mimo-v2.5"
        }
      },
      {
        type: "message-delta",
        sessionId: "session-1",
        timestamp: "2026-06-08T00:00:00.050Z",
        messageId: "msg-1",
        block: { type: "text", text: "first" }
      },
      {
        type: "message-delta",
        sessionId: "session-1",
        timestamp: "2026-06-08T00:00:00.100Z",
        messageId: "msg-1",
        block: { type: "text", text: "second" }
      },
      {
        type: "provider-diagnostic",
        sessionId: "session-1",
        timestamp: "2026-06-08T00:00:00.200Z",
        diagnostic: {
          phase: "stream-end",
          providerId: "flowbit",
          endpoint: "responses",
          elapsedMs: 200,
          chunks: 2,
          bytes: 11
        }
      },
      { type: "agent-end", sessionId: "session-1", timestamp: "2026-06-08T00:00:00.200Z", reason: "stop" }
    ]);

    expect(snapshot.streaming).toMatchObject({
      textDeltaCount: 2,
      textDeltaBytes: 11,
      textDeltaCharacters: 11,
      providerDiagnosticCount: 2,
      firstTextDeltaLatencyMs: 50,
      firstProviderResponseLatencyMs: 20,
      providerStreamDurationMs: 200,
      tokensPerSecond: 10,
      textBytesPerSecond: 55,
      textCharactersPerSecond: 55,
      terminalEventCount: 1,
      terminalReasons: { "stream-end": 1 },
      eventsPerSecond: 30
    });
    expect(JSON.stringify(snapshot.streaming)).not.toContain("firstsecond");
  });

  it("records stream terminal, interrupted, and error observations without storing stream text", () => {
    const snapshot = collectRuntimeMetricsSnapshot([
      { type: "agent-start", sessionId: "session-1", timestamp: "2026-06-08T00:00:00.000Z" },
      {
        type: "message-delta",
        sessionId: "session-1",
        timestamp: "2026-06-08T00:00:00.025Z",
        messageId: "msg-1",
        block: { type: "text", text: "partial" }
      },
      {
        type: "provider-diagnostic",
        sessionId: "session-1",
        timestamp: "2026-06-08T00:00:00.050Z",
        diagnostic: {
          phase: "request-error",
          providerId: "flowbit",
          endpoint: "responses",
          elapsedMs: 50,
          errorKind: "invalid-stream",
          reason: "stream closed before terminal event"
        }
      },
      assistantEnd({ stopReason: "error", error: "invalid-stream: stream closed before terminal event" }),
      { type: "agent-end", sessionId: "session-1", timestamp: "2026-06-08T00:00:00.100Z", reason: "error", error: "invalid-stream" }
    ]);

    expect(snapshot.streaming).toMatchObject({
      textDeltaCount: 1,
      textDeltaBytes: 7,
      terminalEventCount: 3,
      interruptedCount: 2,
      errorCount: 3,
      terminalReasons: {
        "agent-error": 1,
        error: 1,
        "invalid-stream": 1
      }
    });
    expect(JSON.stringify(snapshot.streaming)).not.toContain("partial");
  });

  it("aggregates provider usage and cache tokens from message-end metadata", () => {
    const snapshot = collectRuntimeMetricsSnapshot([
      assistantEnd({
        usage: {
          promptTokens: 100,
          completionTokens: 25,
          totalTokens: 125,
          cacheReadTokens: 40,
          cacheWriteTokens: 10,
          reasoningTokens: 5
        }
      }),
      assistantEnd({
        usage: {
          prompt_tokens: 50,
          completion_tokens: 15,
          total_tokens: 65,
          prompt_tokens_details: { cached_tokens: 12 }
        }
      })
    ]);

    expect(snapshot.providerUsage).toEqual({
      sampleCount: 2,
      promptTokens: 150,
      completionTokens: 40,
      totalTokens: 190,
      cacheReadTokens: 52,
      cacheWriteTokens: 10,
      reasoningTokens: 5
    });
    expect(snapshot.cache).toEqual({
      sampleCount: 2,
      promptTokens: 150,
      readTokens: 52,
      writeTokens: 10,
      missTokens: 98,
      hitRatio: 52 / 150,
      writeRatio: 10 / 150
    });
  });

  it("carries promptAssembly stablePrefixHash and cacheStrategy dimensions into the snapshot", () => {
    const snapshot = collectRuntimeMetricsSnapshot([
      assistantEnd({
        promptAssembly: {
          providerFamily: "openai-compatible",
          modelFamily: "deepseek-v4-plus",
          cacheStrategy: "conservative-stable-prefix",
          stablePrefixHash: "stable-abc",
          toolSchemaHash: "tool-def",
          cacheKey: "prompt:v1:stable-abc"
        },
        usage: {
          promptTokens: 11,
          completionTokens: 7,
          totalTokens: 18,
          cacheWriteTokens: 9
        }
      })
    ]);

    expect(snapshot.latestDimensions).toMatchObject({
      providerFamily: "openai-compatible",
      modelFamily: "deepseek-v4-plus",
      cacheStrategy: "conservative-stable-prefix",
      stablePrefixHash: "stable-abc"
    });
    expect(snapshot.dimensions).toHaveLength(1);
    expect(snapshot.dimensions[0]).toMatchObject({
      promptAssemblyCount: 1,
      providerFamily: "openai-compatible",
      modelFamily: "deepseek-v4-plus",
      cacheStrategy: "conservative-stable-prefix",
      stablePrefixHash: "stable-abc",
      providerUsage: {
        sampleCount: 1,
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
        cacheReadTokens: 0,
        cacheWriteTokens: 9
      },
      cache: {
        sampleCount: 1,
        promptTokens: 11,
        readTokens: 0,
        writeTokens: 9,
        missTokens: 11,
        hitRatio: 0,
        writeRatio: 9 / 11
      }
    });
  });

  it("accepts direct provider usage and prompt assembly metadata for incremental collection", () => {
    const collector = new RuntimeMetricsCollector();
    collector.recordPromptAssembly({
      providerFamily: "anthropic",
      modelFamily: "claude-4.6-plus",
      cacheStrategy: "explicit-cache-breakpoint",
      stablePrefixHash: "stable-direct"
    });
    collector.recordProviderUsage({
      input_tokens: 30,
      output_tokens: 8,
      total_tokens: 38,
      cache_creation_input_tokens: 16
    });

    const snapshot = collector.snapshot();
    expect(snapshot.providerUsage.cacheWriteTokens).toBe(16);
    expect(snapshot.dimensions[0]).toMatchObject({
      providerFamily: "anthropic",
      modelFamily: "claude-4.6-plus",
      cacheStrategy: "explicit-cache-breakpoint",
      stablePrefixHash: "stable-direct",
      providerUsage: {
        sampleCount: 1,
        promptTokens: 30,
        completionTokens: 8,
        totalTokens: 38,
        cacheWriteTokens: 16
      }
    });
  });

  it("does not crash on empty events or unknown metadata fields", () => {
    const empty = collectRuntimeMetricsSnapshot([]);
    expect(empty.eventCount).toBe(0);
    expect(empty.tools.callCount).toBe(0);
    expect(empty.tools.durationMs).toEqual({ count: 0 });
    expect(empty.providerUsage.totalTokens).toBe(0);

    const snapshot = collectRuntimeMetricsSnapshot([
      assistantEnd({
        usage: {
          totalTokens: "not-a-number",
          extraField: { nested: true }
        },
        promptAssembly: {
          stablePrefixHash: 123,
          cacheStrategy: null,
          other: ["ignored"]
        }
      })
    ]);
    expect(snapshot.eventCount).toBe(1);
    expect(snapshot.providerUsage.sampleCount).toBe(0);
    expect(snapshot.dimensions).toEqual([]);
  });
});
