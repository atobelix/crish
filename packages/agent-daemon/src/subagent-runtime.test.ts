import { describe, expect, it } from "vitest";
import {
  ORCHESTRATOR_PROTOCOL_VERSION,
  type OrchestratorEvent,
  type StartRunRequest
} from "@crish/agent-orchestrator";
import type { JsonValue } from "@crish/shared-types";
import type { AgentEvent, AgentMessage, ToolExecutionContext, ToolProgressUpdate } from "@crish/shared-types";
import {
  createDaemonSubagentTool,
  DEFAULT_MAX_SUBAGENT_DEPTH,
  resolveMaxSubagentDepth,
  SUBAGENT_DEPTH_HARD_CAP,
} from "./subagent-runtime";

describe("daemon subagent runtime", () => {
  it("resolves max subagent depth with unlimited and hard cap", () => {
    expect(resolveMaxSubagentDepth(undefined)).toBe(DEFAULT_MAX_SUBAGENT_DEPTH);
    expect(resolveMaxSubagentDepth(3)).toBe(3);
    expect(resolveMaxSubagentDepth(0)).toBe(SUBAGENT_DEPTH_HARD_CAP);
    expect(resolveMaxSubagentDepth(-1)).toBe(SUBAGENT_DEPTH_HARD_CAP);
    expect(resolveMaxSubagentDepth(999)).toBe(SUBAGENT_DEPTH_HARD_CAP);
  });

  it("starts child runs with stable context in metadata and volatile task card as input", async () => {
    const updates: ToolProgressUpdate[] = [];
    let capturedRequest: StartRunRequest | undefined;
    const tool = createDaemonSubagentTool({
      parentRunId: "run_parent",
      parentSessionId: "session_parent",
      cwd: "C:/repo",
      depth: 0,
      permissionMode: "ask",
      async startRun(request) {
        capturedRequest = request;
        return {
          runId: request.id ?? "run_child",
          sessionId: request.sessionId ?? "session_child",
          events: childEvents(request.sessionId ?? "session_child", request.id ?? "run_child")
        };
      },
      cancelRun: () => false
    });
    const context: ToolExecutionContext = {
      toolCallId: "call_parent",
      sessionId: "session_parent",
      cwd: "C:/repo",
      signal: new AbortController().signal,
      emit: (update) => updates.push(update)
    };

    const output = await tool.execute(
      {
        prompt: "implement workflow scheduler",
        description: "workflow scheduler",
        mode: "implement",
        forkPolicy: "task-only"
      },
      context
    );

    expect(capturedRequest?.input).toContain("<subagent_task_card volatile=\"true\"");
    expect(capturedRequest?.input).toContain("implement workflow scheduler");
    expect(capturedRequest?.metadata?.systemPrompt).toEqual(
      expect.stringContaining("<subagent_context stable_prefix=\"true\"")
    );
    expect(capturedRequest?.metadata?.systemPrompt).toEqual(
      expect.stringContaining("You are a focused implement sub-agent running inside the daemon backend.")
    );
    expect(capturedRequest?.metadata).toMatchObject({
      parentRunId: "run_parent",
      parentSessionId: "session_parent",
      parentToolCallId: "call_parent",
      subagentMode: "implement",
      subagentForkPolicy: "task-only",
      prompt: "implement workflow scheduler",
      subagentContextPack: {
        kind: "subagent-context-pack",
        forkPolicy: "task-only"
      }
    });
    expect(output.json).toMatchObject({
      status: "completed",
      finalText: "child complete",
      contextPack: {
        kind: "subagent-context-pack"
      }
    });
    expect(updates.some((update) => JSON.stringify(update.json).includes("daemon-subagent-runtime"))).toBe(true);
  });
});

async function* childEvents(sessionId: string, runId: string): AsyncIterable<OrchestratorEvent> {
  const message: AgentMessage = {
    id: "msg_child",
    role: "assistant",
    createdAt: "2026-06-08T00:00:00.000Z",
    blocks: [{ type: "text", text: "child complete" }]
  };
  yield runtimeEvent(runId, sessionId, {
    type: "message-end",
    sessionId,
    message
  });
  yield runtimeEvent(runId, sessionId, {
    type: "agent-end",
    sessionId,
    timestamp: "2026-06-08T00:00:01.000Z",
    reason: "stop"
  });
}

function runtimeEvent(runId: string, sessionId: string, event: AgentEvent): OrchestratorEvent {
  return {
    protocolVersion: ORCHESTRATOR_PROTOCOL_VERSION,
    id: `event_${event.type}`,
    sequence: event.type === "message-end" ? 1 : 2,
    type: "runtime-event",
    sessionId,
    runId,
    timestamp: "2026-06-08T00:00:00.000Z",
    payload: { event: event as unknown as JsonValue }
  };
}
