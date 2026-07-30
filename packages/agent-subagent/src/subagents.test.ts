import { describe, expect, it, beforeEach } from "vitest";
import { createScriptedProvider } from "@crish/agent-core";
import { createSubagentTool, resetSubagentActiveCount } from "./subagents";
import { defineTextTool } from "@crish/agent-tools";
import {
  InMemoryContextState,
  ProjectProgressLedger
} from "@crish/agent-context";
import type { AgentProviderRequest } from "@crish/agent-core";
import type { ToolExecutionContext, ToolProgressUpdate } from "@crish/shared-types";

describe("subagent tool", () => {
  beforeEach(() => {
    resetSubagentActiveCount();
  });

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

  it("sends stable context as system prompt and volatile task card as user input", async () => {
    let capturedRequest: AgentProviderRequest | undefined;
    const state = new InMemoryContextState();
    state.recordEvent("parent inspected daemon lifecycle");
    state.addTask("pending provider cleanup", "task_config");
    const tool = createSubagentTool({
      cwd: "C:/repo",
      systemPrompt: "Base product rules.",
      contextState: state,
      provider: createScriptedProvider([
        (request) => {
          capturedRequest = request;
          return [{ type: "text-delta", text: "child result" }, { type: "stop", reason: "stop" }];
        }
      ])
    });
    const context: ToolExecutionContext = {
      toolCallId: "call",
      sessionId: "parent",
      cwd: "C:/repo",
      signal: new AbortController().signal,
      emit: () => undefined
    };

    const output = await tool.execute(
      { prompt: "do volatile work", description: "child task", mode: "implement" },
      context
    );

    expect(capturedRequest?.systemPrompt).toContain("<subagent_context stable_prefix=\"true\"");
    expect(capturedRequest?.systemPrompt).toContain("Base product rules.");
    expect(capturedRequest?.systemPrompt).toContain("parent inspected daemon lifecycle");
    expect(capturedRequest?.messages.at(-1)?.blocks).toMatchObject([
      {
        type: "text",
        text: expect.stringContaining("<subagent_task_card volatile=\"true\"")
      }
    ]);
    expect(capturedRequest?.messages.at(-1)?.blocks).toMatchObject([
      {
        type: "text",
        text: expect.stringContaining("do volatile work")
      }
    ]);
    expect(String((output.json as Record<string, unknown>).contextPack)).not.toBe("");
  });

  it("can render shared project progress from a ledger into the stable sub-agent prefix", async () => {
    let capturedRequest: AgentProviderRequest | undefined;
    const ledger = new ProjectProgressLedger({ now: () => "2026-06-08T00:00:00.000Z" });
    ledger.addStablePrinciple({ text: "Single product backend path only." });
    ledger.upsertProgressItem({
      title: "Subagent context pack",
      status: "completed",
      summary: "Stable prefix and volatile task cards are split."
    });
    ledger.recordSubagentTask({
      id: "task_review",
      agentId: "worker-a",
      title: "Review daemon lifecycle",
      status: "completed"
    });
    const tool = createSubagentTool({
      cwd: "C:/repo",
      projectProgressLedger: ledger,
      provider: createScriptedProvider([
        (request) => {
          capturedRequest = request;
          return [{ type: "text-delta", text: "ok" }, { type: "stop", reason: "stop" }];
        }
      ])
    });
    const context: ToolExecutionContext = {
      toolCallId: "call",
      sessionId: "parent",
      cwd: "C:/repo",
      signal: new AbortController().signal,
      emit: () => undefined
    };

    await tool.execute({ prompt: "continue implementation", mode: "implement" }, context);

    expect(capturedRequest?.systemPrompt).toContain("Shared Project Progress");
    expect(capturedRequest?.systemPrompt).toContain("Principle: Single product backend path only.");
    expect(capturedRequest?.systemPrompt).toContain("Progress[completed]: Subagent context pack");
    expect(capturedRequest?.systemPrompt).toContain("Task[completed]: worker-a/task_review");
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
    expect(progressStatuses).toContain("pending");
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

  it("emits failed progress and structured error when provider resolve throws before start", async () => {
    const progressStatuses: string[] = [];
    const tool = createSubagentTool({
      cwd: "C:/repo",
      provider: async () => {
        throw new Error("provider resolve failed");
      },
      onProgress: (event) => {
        progressStatuses.push(event.status);
      }
    });
    const context: ToolExecutionContext = {
      toolCallId: "call",
      sessionId: "parent",
      cwd: "C:/repo",
      signal: new AbortController().signal,
      emit: () => undefined
    };

    const output = await tool.execute({ prompt: "do work", description: "setup fail" }, context);
    const json = output.json as Record<string, unknown>;

    expect(json).toMatchObject({
      status: "failed",
      error: "provider resolve failed",
      description: "setup fail"
    });
    expect(progressStatuses).toContain("failed");
    expect(String(json.completionSummary)).toContain("provider resolve failed");
  });

  it("denies creation when global maxConcurrent is exceeded", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blockingTool = createSubagentTool({
      cwd: "C:/repo",
      depthGuard: { maxDepth: 2, maxSiblings: 4, maxConcurrent: 1 },
      provider: async () => {
        await hold;
        return createScriptedProvider([[{ type: "text-delta", text: "done" }, { type: "stop", reason: "stop" }]]);
      }
    });
    const deniedTool = createSubagentTool({
      cwd: "C:/repo",
      depthGuard: { maxDepth: 2, maxSiblings: 4, maxConcurrent: 1 },
      provider: createScriptedProvider([[{ type: "text-delta", text: "never" }, { type: "stop", reason: "stop" }]])
    });
    const context: ToolExecutionContext = {
      toolCallId: "call",
      sessionId: "parent",
      cwd: "C:/repo",
      signal: new AbortController().signal,
      emit: () => undefined
    };

    const running = blockingTool.execute({ prompt: "hold", description: "holder" }, context);
    // 让 holder 先占住全局并发配额
    await new Promise((r) => setTimeout(r, 10));
    const denied = await deniedTool.execute({ prompt: "overflow", description: "denied child" }, context);
    release();
    await running;

    expect(denied.json).toMatchObject({
      error: "max-concurrent-exceeded",
      maxConcurrent: 1,
      description: "denied child"
    });
    expect(String(denied.text)).toContain("maximum concurrent");
  });
});
