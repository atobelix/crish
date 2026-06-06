import { describe, expect, it } from "vitest";
import { createScriptedProvider, createSubagentTool, defineTextTool, InMemoryContextState } from ".";
import type { ToolExecutionContext, ToolProgressUpdate } from "./types";

describe("subagent tool", () => {
  it("runs a child runtime and emits progress", async () => {
    const updates: ToolProgressUpdate[] = [];
    const tool = createSubagentTool({
      cwd: "C:/repo",
      provider: createScriptedProvider([[{ type: "text-delta", text: "child result" }, { type: "stop", reason: "stop" }]])
    });
    const context: ToolExecutionContext = {
      toolCallId: "call",
      sessionId: "parent",
      cwd: "C:/repo",
      signal: new AbortController().signal,
      emit: (update) => updates.push(update)
    };

    const output = await tool.execute({ prompt: "do work", description: "child task", mode: "research" }, context);

    expect(output.text).toBe("child result");
    expect(output.json).toMatchObject({
      parentSessionId: "parent",
      parentToolCallId: "call",
      description: "child task",
      finalText: "child result",
      finalReason: "stop"
    });
    expect(updates.some((update) => update.text?.includes("Sub-agent started"))).toBe(true);
    expect(updates.some((update) => update.text?.includes("Sub-agent finished"))).toBe(true);
  });

  it("returns structured status, progress timeline, and task handoff state", async () => {
    const updates: ToolProgressUpdate[] = [];
    const progressStatuses: string[] = [];
    const state = new InMemoryContextState();
    const inspectTool = defineTextTool({
      name: "inspect",
      description: "Inspect child workspace",
      category: "filesystem",
      readOnly: true,
      execute: () => "checked"
    });
    const tool = createSubagentTool({
      cwd: "C:/repo",
      contextState: state,
      tools: [inspectTool],
      provider: createScriptedProvider([
        [
          { type: "tool-call", id: "call_inspect", toolName: "inspect", input: { path: "src/app.ts" } },
          { type: "stop", reason: "tool-call" }
        ],
        [{ type: "text-delta", text: "child verified files" }, { type: "stop", reason: "stop" }]
      ]),
      onProgress(event) {
        progressStatuses.push(event.status);
      }
    });
    const context: ToolExecutionContext = {
      toolCallId: "call",
      sessionId: "parent",
      cwd: "C:/repo",
      signal: new AbortController().signal,
      emit: (update) => updates.push(update)
    };

    const output = await tool.execute({ prompt: "verify files", description: "verify child", mode: "verify" }, context);
    const json = output.json as Record<string, unknown>;

    expect(json).toMatchObject({
      description: "verify child",
      mode: "verify",
      status: "completed",
      finalText: "child verified files"
    });
    expect(json.stats).toMatchObject({ toolUses: 1 });
    expect(Array.isArray(json.timeline)).toBe(true);
    expect((json.timeline as unknown[]).length).toBeGreaterThanOrEqual(3);
    expect(progressStatuses).toContain("started");
    expect(progressStatuses).toContain("running");
    expect(progressStatuses).toContain("completed");
    expect(updates.some((update) => Boolean((update.json as Record<string, unknown> | undefined)?.subagent))).toBe(true);

    const snapshot = state.snapshotForCompression();
    expect(snapshot.pendingTasks).toEqual([]);
    expect(snapshot.completedTaskSummaries.join("\n")).toContain("verify child");
    expect(snapshot.completedTaskSummaries.join("\n")).toContain("child verified files");
    expect(snapshot.sessionEvents.join("\n")).toContain("started");
  });

  it("marks a child agent as failed when it exits for max turns instead of a clean stop", async () => {
    const updates: ToolProgressUpdate[] = [];
    const loopTool = defineTextTool({
      name: "loop",
      description: "Loop forever",
      category: "internal",
      readOnly: true,
      execute: () => "again"
    });
    const tool = createSubagentTool({
      cwd: "C:/repo",
      maxTurns: 1,
      tools: [loopTool],
      provider: createScriptedProvider([
        [
          { type: "tool-call", id: "call_loop", toolName: "loop", input: {} },
          { type: "stop", reason: "tool-call" }
        ]
      ])
    });
    const context: ToolExecutionContext = {
      toolCallId: "parent_call",
      sessionId: "parent_session",
      cwd: "C:/repo",
      signal: new AbortController().signal,
      emit: (update) => updates.push(update)
    };

    const output = await tool.execute({ prompt: "keep going", description: "loop child", mode: "research" }, context);
    const json = output.json as Record<string, unknown>;

    expect(json).toMatchObject({
      parentSessionId: "parent_session",
      parentToolCallId: "parent_call",
      description: "loop child",
      status: "failed",
      finalReason: "max-turns"
    });
    expect(String(json.completionSummary)).toContain("failed");
    expect(updates.some((update) => JSON.stringify(update.json).includes('"finalReason":"max-turns"'))).toBe(true);
  });

  it("lets the parent choose sub-agent permissions from the requested mode", async () => {
    let observedMode = "";
    const tool = createSubagentTool({
      cwd: "C:/repo",
      provider: createScriptedProvider([[{ type: "text-delta", text: "reviewed" }, { type: "stop", reason: "stop" }]]),
      permissionPolicy: (input) => {
        observedMode = String(input.mode ?? "");
        return { decide: () => ({ behavior: "allow" as const, reason: "test" }) };
      }
    });
    const context: ToolExecutionContext = {
      toolCallId: "call",
      sessionId: "parent",
      cwd: "C:/repo",
      signal: new AbortController().signal,
      emit: () => undefined
    };

    await tool.execute({ prompt: "review", mode: "verify" }, context);

    expect(observedMode).toBe("verify");
  });
});
