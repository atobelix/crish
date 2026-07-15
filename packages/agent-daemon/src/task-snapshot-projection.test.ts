import { describe, expect, it } from "vitest";
import type { JsonObject } from "@crish/shared-types";
import type { AgentEvent } from "@crish/shared-types";
import type { OrchestratorEvent, OrchestratorRunRecord } from "@crish/agent-orchestrator";
import { buildDaemonTaskSnapshot } from "./task-snapshot-projection";

describe("buildDaemonTaskSnapshot", () => {
  it("projects runtime messages and run metadata", () => {
    const events = [
      runQueued("event-1"),
      runtime("event-2", {
        type: "message-delta",
        sessionId: "session-1",
        timestamp: "2026-01-01T00:00:02.000Z",
        messageId: "assistant-1",
        block: { type: "text", text: "hello " },
      }),
      runtime("event-3", {
        type: "message-end",
        sessionId: "session-1",
        message: {
          id: "assistant-1",
          role: "assistant",
          createdAt: "2026-01-01T00:00:03.000Z",
          blocks: [{ type: "text", text: "hello world" }],
        },
      }),
      event("event-4", "run-completed", { run: { ...runRecord(), status: "completed" } as unknown as JsonObject }),
    ];

    const snapshot = buildDaemonTaskSnapshot({ events });

    expect(snapshot).toMatchObject({
      runId: "run-1",
      sessionId: "session-1",
      status: "completed",
      title: "Build product snapshot",
      progressLabel: "Completed",
      currentRun: {
        cwd: "C:/repo",
        metadata: { prompt: "Build product snapshot" },
      },
    });
    expect(snapshot.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "Build product snapshot"],
      ["assistant", "hello world"],
    ]);
  });

  it("merges sequential text and thought blocks correctly without newlines", () => {
    const events = [
      runQueued("event-1"),
      runtime("event-2", {
        type: "message-end",
        sessionId: "session-1",
        message: {
          id: "assistant-1",
          role: "assistant",
          createdAt: "2026-01-01T00:00:03.000Z",
          blocks: [
            { type: "text", text: "你" },
            { type: "text", text: "好" },
            { type: "text", text: "！" },
            { type: "text", text: "\n" },
            { type: "text", text: "我" },
            { type: "text", text: "在" }
          ],
        },
      }),
    ];

    const snapshot = buildDaemonTaskSnapshot({ events });
    expect(snapshot.messages[1]?.content).toBe("你好！\n我在");
  });

  it("projects runtime and orchestrator errors", () => {
    const runtimeErrorEvents = [
      runQueued("event-1"),
      runtime("event-2", {
        type: "runtime-error",
        sessionId: "session-1",
        timestamp: "2026-01-01T00:00:02.000Z",
        error: "provider exploded",
      }),
    ];

    expect(buildDaemonTaskSnapshot({ events: runtimeErrorEvents }).latestError).toBe("provider exploded");

    const failed = buildDaemonTaskSnapshot({
      events: [
        runQueued("event-1"),
        event("event-2", "run-failed", {
          run: { ...runRecord(), status: "failed", error: "run failed" } as unknown as JsonObject,
          error: "run failed",
        }),
      ],
    });

    expect(failed).toMatchObject({
      status: "failed",
      latestError: "run failed",
    });
    expect(failed.messages.at(-1)).toMatchObject({
      role: "system",
      content: "run failed",
    });
  });

  it("projects approval requested and resolved state", () => {
    const requested = buildDaemonTaskSnapshot({
      events: [
        runQueued("event-1"),
        runtime("event-2", {
          type: "approval-requested",
          sessionId: "session-1",
          timestamp: "2026-01-01T00:00:02.000Z",
          request: {
            id: "tool-1",
            sessionId: "session-1",
            cwd: "C:/repo",
            toolCallId: "tool-1",
            toolName: "shell_command",
            parameters: { command: "npm install" },
            summary: "npm install",
            toolMetadata: {
              label: "Shell",
              description: "Run a command",
              category: "terminal",
              concurrency: "exclusive",
              isReadOnly: false,
              summarize: "npm install",
            },
            metadata: {
              risk: "network",
              reason: "Network or package-management command",
              recommendSnapshot: false,
            },
          },
        } as unknown as AgentEvent),
      ],
    });

    expect(requested.status).toBe("awaiting-approval");
    expect(requested.approval).toMatchObject({
      toolCallId: "tool-1",
      toolName: "shell_command",
      summary: "npm install",
      risk: "network",
      riskReason: "Network or package-management command",
      recommendSnapshot: false,
      metadata: {
        risk: "network",
        reason: "Network or package-management command",
        recommendSnapshot: false,
      },
    });
    expect(requested.pendingToolCalls).toEqual([
      expect.objectContaining({
        id: "tool-1",
        status: "approval-required",
        approvalMetadata: {
          risk: "network",
          reason: "Network or package-management command",
          recommendSnapshot: false,
        },
      }),
    ]);

    const resolved = buildDaemonTaskSnapshot({
      events: [
        runQueued("event-1"),
        requestedEvent("event-2"),
        runtime("event-3", {
          type: "approval-resolved",
          sessionId: "session-1",
          requestId: "tool-1",
          decision: { behavior: "allow" },
          timestamp: "2026-01-01T00:00:03.000Z",
        }),
      ],
    });

    expect(resolved.approval).toBeUndefined();
    expect(resolved.pendingToolCalls).toEqual([]);
  });

  it("projects background command task snapshots from tool output json", () => {
    const snapshot = buildDaemonTaskSnapshot({
      events: [
        runQueued("event-1"),
        runtime("event-2", {
          type: "tool-end",
          sessionId: "session-1",
          batchId: "batch-1",
          timestamp: "2026-01-01T00:00:02.000Z",
          result: {
            id: "tool-1",
            toolName: "shell_command",
            isError: false,
            durationMs: 5,
            output: {
              text: "Background command started",
              json: {
                id: "bg-1",
                command: "npm run dev",
                cwd: "C:/repo",
                state: "running",
                startedAt: "2026-01-01T00:00:02.000Z",
                updatedAt: "2026-01-01T00:00:02.000Z",
                outputPreview: "ready",
              },
            },
          },
        }),
      ],
    });

    expect(snapshot.backgroundTasks).toEqual([
      expect.objectContaining({
        id: "bg-1",
        kind: "command",
        state: "running",
        command: "npm run dev",
        outputPreview: "ready",
      }),
    ]);
  });

  it("projects provider usage, cache, and progress from runtime events", () => {
    const snapshot = buildDaemonTaskSnapshot({
      events: [
        runQueued("event-1"),
        runtime("event-2", {
          type: "turn-start",
          sessionId: "session-1",
          turnIndex: 0,
          timestamp: "2026-01-01T00:00:02.000Z",
        }),
        runtime("event-3", {
          type: "message-delta",
          sessionId: "session-1",
          timestamp: "2026-01-01T00:00:03.000Z",
          messageId: "assistant-1",
          block: { type: "text", text: "done" },
        }),
        runtime("event-4", {
          type: "message-end",
          sessionId: "session-1",
          message: {
            id: "assistant-1",
            role: "assistant",
            createdAt: "2026-01-01T00:00:04.000Z",
            blocks: [{ type: "text", text: "done" }],
            metadata: {
              promptAssembly: {
                stablePrefixHash: "stable-123",
                cacheKey: "cache-123",
                cacheStrategy: "automatic-prefix",
              },
              usage: {
                promptTokens: 100,
                completionTokens: 25,
                totalTokens: 125,
                cacheReadTokens: 80,
                cacheWriteTokens: 12,
                reasoningTokens: 5,
              },
            },
          },
        }),
      ],
    });

    expect(snapshot.usage).toEqual({
      sampleCount: 1,
      promptTokens: 100,
      completionTokens: 25,
      totalTokens: 125,
      reasoningTokens: 5,
    });
    expect(snapshot.cache).toEqual({
      sampleCount: 1,
      promptTokens: 100,
      readTokens: 80,
      writeTokens: 12,
      missTokens: 20,
      hitRatio: 0.8,
      writeRatio: 0.12,
      stablePrefixHash: "stable-123",
      cacheKey: "cache-123",
      cacheStrategy: "automatic-prefix",
    });
    expect(snapshot.progress).toMatchObject({
      label: "Turn 1 started",
      eventCount: 3,
      turnCount: 1,
      textDeltaCount: 1,
      toolCallCount: 0,
      approvalPending: false,
    });
  });
});

function requestedEvent(id: string): OrchestratorEvent {
  return runtime(id, {
    type: "approval-requested",
    sessionId: "session-1",
    timestamp: "2026-01-01T00:00:02.000Z",
    request: {
      id: "tool-1",
      sessionId: "session-1",
      cwd: "C:/repo",
      toolCallId: "tool-1",
      toolName: "shell_command",
      parameters: { command: "npm install" },
      summary: "npm install",
      toolMetadata: {
        label: "Shell",
        description: "Run a command",
        category: "terminal",
        concurrency: "exclusive",
        isReadOnly: false,
        summarize: "npm install",
      },
      metadata: {
        risk: "network",
        reason: "Network or package-management command",
        recommendSnapshot: false,
      },
    },
  } as unknown as AgentEvent);
}

function runQueued(id: string): OrchestratorEvent {
  return event(id, "run-queued", { run: runRecord() as unknown as JsonObject });
}

function runtime(id: string, agentEvent: AgentEvent): OrchestratorEvent {
  return event(id, "runtime-event", { event: agentEvent as unknown as JsonObject });
}

function event(
  id: string,
  type: OrchestratorEvent["type"],
  payload: JsonObject
): OrchestratorEvent {
  return {
    protocolVersion: 1,
    id,
    sequence: Number(id.split("-").at(-1)),
    type,
    sessionId: "session-1",
    runId: "run-1",
    timestamp: `2026-01-01T00:00:0${Number(id.split("-").at(-1))}.000Z`,
    payload,
  };
}

function runRecord(): OrchestratorRunRecord {
  return {
    id: "run-1",
    sessionId: "session-1",
    cwd: "C:/repo",
    status: "queued",
    createdAt: "2026-01-01T00:00:01.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    metadata: { prompt: "Build product snapshot" },
  };
}
