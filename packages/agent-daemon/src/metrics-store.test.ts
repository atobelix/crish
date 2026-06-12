import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@crish/shared-types";
import { FileMetricsStore } from "./metrics-store";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("FileMetricsStore", () => {
  it("persists run metrics and restores queryable snapshots", async () => {
    const storePath = join(await tempDir(), "metrics.json");
    const store = new FileMetricsStore(storePath);
    await store.restore();

    await store.recordAgentEvent({ runId: "run_1", sessionId: "session_1", event: agentEvent("agent-start") });
    await store.recordAgentEvent({ runId: "run_1", sessionId: "session_1", event: toolEndEvent("shell", 100, false) });
    await store.recordAgentEvent({ runId: "run_1", sessionId: "session_1", event: usageEvent() });
    await store.recordAgentEvent({ runId: "run_1", sessionId: "session_1", event: agentEvent("agent-end") });

    const restored = new FileMetricsStore(storePath);
    await restored.restore();
    const response = restored.query({ runId: "run_1", includeRuns: true });

    expect(response.status).toBe("ok");
    expect(response.source).toMatchObject({
      kind: "jsonl",
      generation: 4,
      status: "ok",
      badLineCount: 0,
    });
    expect(response.summary).toMatchObject({
      scope: "run",
      runCount: 1,
      sessionCount: 1,
      snapshot: {
        eventCount: 4,
        tools: {
          callCount: 1,
          byName: {
            shell: {
              callCount: 1,
              durationMs: {
                p50: 100,
              },
            },
          },
        },
        providerUsage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
        },
        cache: {
          sampleCount: 1,
          promptTokens: 10,
          readTokens: 3,
          writeTokens: 2,
          missTokens: 7,
          hitRatio: 0.3,
          writeRatio: 0.2,
        },
        trace: {
          spanCount: 3,
          spans: expect.arrayContaining([
            expect.objectContaining({ kind: "conversation", status: "ok" }),
            expect.objectContaining({ spanId: "tool:tool_1", output: expect.objectContaining({ redacted: true }) }),
          ]),
        },
      },
    });
    expect(response.runs?.[0]).toMatchObject({
      runId: "run_1",
      sessionId: "session_1",
    });

    const sessionResponse = restored.query({ sessionId: "session_1" });
    expect(sessionResponse.summary).toMatchObject({
      scope: "session",
      runCount: 1,
      sessionCount: 1,
    });

    const globalResponse = restored.query();
    expect(globalResponse.summary).toMatchObject({
      scope: "global",
      runCount: 1,
      sessionCount: 1,
    });
  });

  it("returns degraded diagnostics instead of silently returning empty metrics on store failure", async () => {
    const dir = await tempDir();
    const store = new FileMetricsStore(dir);
    await store.restore();
    await store.recordAgentEvent({ runId: "run_1", sessionId: "session_1", event: agentEvent("agent-start") });

    const response = store.query();
    expect(response.status).toBe("degraded");
    expect(response.diagnostic).toMatchObject({
      code: "METRICS_STORE_WRITE_FAILED",
      path: dir,
    });
    expect(response.summary.snapshot.eventCount).toBe(1);
  });

  it("tolerates bad JSONL lines while rebuilding the materialized snapshot", async () => {
    const storePath = join(await tempDir(), "metrics.jsonl");
    const store = new FileMetricsStore(storePath);
    await store.restore();
    await store.recordAgentEvent({ runId: "run_1", sessionId: "session_1", event: toolEndEvent("shell", 120, false) });
    await appendFile(storePath, "{bad-json}\n", "utf8");
    await appendFile(storePath, `${JSON.stringify({ type: "unknown", version: 1 })}\n`, "utf8");

    const restored = new FileMetricsStore(storePath);
    await restored.restore();
    const response = restored.query({ runId: "run_1" });

    expect(response.status).toBe("degraded");
    expect(response.source).toMatchObject({
      kind: "jsonl",
      badLineCount: 2,
      status: "degraded",
    });
    expect(response.diagnostic?.code).toBe("METRICS_STORE_BAD_LINE");
    expect(response.summary.snapshot.tools.byName.shell.callCount).toBe(1);
  });
});

function agentEvent(type: "agent-start" | "agent-end"): AgentEvent {
  if (type === "agent-start") {
    return { type, sessionId: "session_1", timestamp: "2026-06-08T00:00:00.000Z" };
  }
  return { type, sessionId: "session_1", timestamp: "2026-06-08T00:00:03.000Z", reason: "stop" };
}

function toolEndEvent(toolName: string, durationMs: number, isError: boolean): AgentEvent {
  return {
    type: "tool-end",
    sessionId: "session_1",
    batchId: "batch_1",
    timestamp: "2026-06-08T00:00:01.000Z",
    result: {
      id: "tool_1",
      toolName,
      durationMs,
      isError,
      output: { text: "ok" },
    },
  };
}

function usageEvent(): AgentEvent {
  return {
    type: "message-end",
    sessionId: "session_1",
    message: {
      id: "message_1",
      role: "assistant",
      createdAt: "2026-06-08T00:00:02.000Z",
      blocks: [{ type: "text", text: "done" }],
      metadata: {
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
        },
        promptAssembly: {
          providerId: "flowbit",
          configuredModel: "mimo-v2.5",
          cacheStrategy: "stable-prefix",
          stablePrefixHash: "prefix_hash",
        },
      },
    },
  };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "daemon-metrics-"));
  tempDirs.push(dir);
  return dir;
}
