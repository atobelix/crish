import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentRuntime,
  allowAllPermissionPolicy,
  createScriptedProvider,
  createScriptedTextProvider,
  createWriteFileTool,
  defineTextTool,
  evaluateRuntimeStageRequirements,
  formatRuntimeStageSuiteResult,
  stageRequirementsPassed,
  summarizeRuntimeProbeReport,
  type ProviderStreamEvent,
  runRuntimeStageSuite,
  runRuntimeWithProbe
} from ".";

let workspaceRoot = "";

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "agent-runtime-stage-suite-"));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe("runtime probe", () => {
  it("collects long-run tool and event telemetry", async () => {
    const tool = defineTextTool({
      name: "inspect",
      description: "Inspect",
      category: "terminal",
      readOnly: true,
      execute: () => "ok"
    });
    const provider = createScriptedProvider([
      [
        { type: "text-delta", text: "Inspecting." },
        { type: "tool-call", id: "call_inspect", toolName: "inspect", input: { command: "git status --short" } },
        { type: "stop", reason: "tool-call" }
      ],
      [{ type: "text-delta", text: "Done." }, { type: "stop", reason: "stop" }]
    ]);
    const runtime = new AgentRuntime({
      cwd: "C:/repo",
      provider,
      tools: [tool]
    });

    const result = await runRuntimeWithProbe(runtime, "check");

    expect(result.report.toolCallCount).toBe(1);
    expect(result.report.toolBatchCount).toBe(1);
    expect(result.report.toolCallsByName).toMatchObject({ inspect: 1 });
    expect(result.report.firstEventMs.textDelta).toBeTypeOf("number");
    expect(result.report.firstEventMs.toolCallDelta).toBeTypeOf("number");
    expect(result.report.firstEventMs.toolStart).toBeTypeOf("number");
    expect(result.report.errors).toEqual([]);
    expect(result.messages.at(-1)?.role).toBe("assistant");
  });

  it("streams probe progress while bounding stored events", async () => {
    const provider = createScriptedProvider([
      [
        { type: "text-delta", text: "hello" },
        { type: "stop", reason: "stop" }
      ]
    ]);
    const runtime = new AgentRuntime({
      cwd: "C:/repo",
      provider
    });
    const seen: string[] = [];

    const result = await runRuntimeWithProbe(runtime, "check", {
      maxStoredEvents: 2,
      onEvent(event, report) {
        seen.push(`${report.eventCount}:${event.type}`);
      }
    });

    expect(result.events.length).toBe(2);
    expect(result.report.eventCount).toBeGreaterThan(2);
    expect(seen.length).toBe(result.report.eventCount);
  });

  it("runs staged probes and carries bounded context into the next stage", async () => {
    const write = createWriteFileTool({ workspaceRoot });
    const initialMessageCounts: number[] = [];
    const providers = [
      createScriptedProvider([
        [
          { type: "tool-call", id: "call_write", toolName: "write_file", input: { path: "a.txt", content: "alpha" } },
          { type: "stop", reason: "tool-call" }
        ],
        [{ type: "text-delta", text: "wrote file" }, { type: "stop", reason: "stop" }]
      ]),
      createScriptedProvider([[{ type: "text-delta", text: "continued" }, { type: "stop", reason: "stop" }]])
    ];

    const suite = await runRuntimeStageSuite({
      workspaceRoot,
      maxContextMessages: 3,
      stages: [
        {
          name: "write",
          prompt: "write",
          requiredToolCalls: ["write_file"],
          requiredToolCallCounts: { write_file: 1 },
          requiredFiles: ["a.txt"],
          requiredFileIncludes: [{ file: "a.txt", text: "alpha" }]
        },
        { name: "continue", prompt: "continue" }
      ],
      createRuntime({ index, initialMessages }) {
        initialMessageCounts.push(initialMessages.length);
        return new AgentRuntime({
          cwd: workspaceRoot,
          provider: providers[index]!,
          tools: [write],
          initialMessages,
          permissionPolicy: allowAllPermissionPolicy
        });
      }
    });

    expect(suite.completedStageCount).toBe(2);
    expect(suite.errors).toEqual([]);
    expect(initialMessageCounts[0]).toBe(0);
    expect(initialMessageCounts[1]).toBeGreaterThan(0);
    expect(initialMessageCounts[1]).toBeLessThanOrEqual(3);
    expect(suite.aggregateToolCallsByName).toMatchObject({ write_file: 1 });
  });

  it("stops staged probes when required artifacts are missing", async () => {
    const provider = createScriptedProvider([[{ type: "text-delta", text: "I forgot the tool." }, { type: "stop", reason: "stop" }]]);

    const suite = await runRuntimeStageSuite({
      workspaceRoot,
      stages: [
        { name: "missing-write", prompt: "write", requiredToolCalls: ["write_file"], requiredFiles: ["missing.txt"] },
        { name: "should-not-run", prompt: "continue" }
      ],
      createRuntime() {
        return new AgentRuntime({
          cwd: workspaceRoot,
          provider,
          tools: [createWriteFileTool({ workspaceRoot })],
          permissionPolicy: allowAllPermissionPolicy
        });
      }
    });

    expect(suite.completedStageCount).toBe(1);
    expect(suite.stoppedAtStage).toBe("missing-write");
    expect(suite.errors.join("\n")).toContain("tool write_file failed");
    expect(suite.errors.join("\n")).toContain("file missing.txt failed");
  });

  it("fails staged probes when required tool counts or file content are missing", async () => {
    const write = createWriteFileTool({ workspaceRoot });
    const provider = createScriptedProvider([
      [
        { type: "tool-call", id: "call_write", toolName: "write_file", input: { path: "a.txt", content: "alpha" } },
        { type: "stop", reason: "tool-call" }
      ],
      [{ type: "text-delta", text: "done" }, { type: "stop", reason: "stop" }]
    ]);

    const suite = await runRuntimeStageSuite({
      workspaceRoot,
      stages: [
        {
          name: "weak-write",
          prompt: "write",
          requiredToolCallCounts: { write_file: 2 },
          requiredFiles: ["a.txt"],
          requiredFileIncludes: [{ file: "a.txt", text: "beta" }]
        }
      ],
      createRuntime() {
        return new AgentRuntime({
          cwd: workspaceRoot,
          provider,
          tools: [write],
          permissionPolicy: allowAllPermissionPolicy
        });
      }
    });

    expect(suite.completedStageCount).toBe(1);
    expect(suite.stoppedAtStage).toBe("weak-write");
    expect(suite.errors.join("\n")).toContain("tool write_file>=2 failed");
    expect(suite.errors.join("\n")).toContain("required text was not found");
  });

  it("fails staged probes when forbidden tools are called", async () => {
    const tool = defineTextTool({
      name: "shell_command",
      description: "Run shell",
      category: "terminal",
      readOnly: true,
      execute: () => "ok"
    });
    const provider = createScriptedProvider([
      [
        { type: "tool-call", id: "call_shell", toolName: "shell_command", input: { command: "pwd" } },
        { type: "stop", reason: "tool-call" }
      ],
      [{ type: "text-delta", text: "done" }, { type: "stop", reason: "stop" }]
    ]);

    const suite = await runRuntimeStageSuite({
      workspaceRoot,
      stages: [{ name: "no-shell", prompt: "write directly", forbiddenToolCalls: ["shell_command"] }],
      createRuntime() {
        return new AgentRuntime({
          cwd: workspaceRoot,
          provider,
          tools: [tool]
        });
      }
    });

    expect(suite.completedStageCount).toBe(1);
    expect(suite.stoppedAtStage).toBe("no-shell");
    expect(suite.errors.join("\n")).toContain("tool !shell_command failed");
  });

  it("can stop a stage as soon as requirements are met", async () => {
    const write = createWriteFileTool({ workspaceRoot });
    let requestCount = 0;
    const steps: ProviderStreamEvent[][] = [
      [
        { type: "tool-call", id: "call_write", toolName: "write_file", input: { path: "done.txt", content: "ready" } },
        { type: "stop", reason: "tool-call" }
      ],
      [
        { type: "tool-call", id: "call_extra", toolName: "write_file", input: { path: "extra.txt", content: "unneeded" } },
        { type: "stop", reason: "tool-call" }
      ]
    ];
    const provider = createScriptedProvider([
      () => {
        requestCount += 1;
        return steps[0]!;
      },
      () => {
        requestCount += 1;
        return steps[1]!;
      }
    ]);

    const suite = await runRuntimeStageSuite({
      workspaceRoot,
      stages: [
        {
          name: "stop-early",
          prompt: "write done.txt",
          requiredToolCallCounts: { write_file: 1 },
          requiredFiles: ["done.txt"],
          stopWhenRequirementsMet: true
        }
      ],
      createRuntime() {
        return new AgentRuntime({
          cwd: workspaceRoot,
          provider,
          tools: [write],
          permissionPolicy: allowAllPermissionPolicy
        });
      }
    });

    expect(suite.completedStageCount).toBe(1);
    expect(suite.errors).toEqual([]);
    expect(requestCount).toBe(1);
  });

  it("retries a failed stage with a clean context when configured", async () => {
    const write = createWriteFileTool({ workspaceRoot });
    const initialMessageCounts: number[] = [];
    const provider = createScriptedProvider([
      [{ type: "text-delta", text: "I only thought about the task." }, { type: "stop", reason: "stop" }],
      [
        { type: "tool-call", id: "call_write", toolName: "write_file", input: { path: "retry.txt", content: "ready" } },
        { type: "stop", reason: "tool-call" }
      ],
      [{ type: "text-delta", text: "done" }, { type: "stop", reason: "stop" }]
    ]);

    const suite = await runRuntimeStageSuite({
      workspaceRoot,
      stages: [
        {
          name: "retry-write",
          prompt: "write retry.txt",
          retryPrompt: "call write_file for retry.txt now",
          maxAttempts: 2,
          resetContextOnRetry: true,
          requiredToolCallCounts: { write_file: 1 },
          requiredFiles: ["retry.txt"]
        }
      ],
      createRuntime({ initialMessages }) {
        initialMessageCounts.push(initialMessages.length);
        return new AgentRuntime({
          cwd: workspaceRoot,
          provider,
          tools: [write],
          initialMessages,
          permissionPolicy: allowAllPermissionPolicy
        });
      }
    });

    expect(suite.completedStageCount).toBe(1);
    expect(suite.errors).toEqual([]);
    expect(suite.stages[0]?.attemptCount).toBe(2);
    expect(suite.stages[0]?.attemptErrors?.join("\n")).toContain("write_file");
    expect(initialMessageCounts).toEqual([0, 0]);
  });

  it("continues staged probes after a deterministic fallback satisfies file requirements", async () => {
    const provider = createScriptedProvider([
      [{ type: "text-delta", text: "I inspected but forgot to write." }, { type: "stop", reason: "stop" }],
      [{ type: "text-delta", text: "next stage" }, { type: "stop", reason: "stop" }]
    ]);

    const suite = await runRuntimeStageSuite({
      workspaceRoot,
      stages: [
        {
          name: "fallback-report",
          prompt: "create report.md",
          requiredFiles: ["report.md"],
          requiredFileIncludes: [{ file: "report.md", text: "fallback ready" }],
          async fallback() {
            await writeFile(join(workspaceRoot, "report.md"), "fallback ready", "utf8");
          }
        },
        { name: "continue", prompt: "continue" }
      ],
      createRuntime({ initialMessages }) {
        return new AgentRuntime({
          cwd: workspaceRoot,
          provider,
          initialMessages
        });
      }
    });

    expect(suite.completedStageCount).toBe(2);
    expect(suite.errors).toEqual([]);
    expect(suite.stages[0]?.fallbackApplied).toBe(true);
    expect(suite.stages[0]?.attemptErrors?.join("\n")).toContain("report.md");
  });

  it("tracks scripted provider callCount, stores requests, and supports exhaust policies", async () => {
    const provider = createScriptedProvider(
      [[{ type: "text-delta", text: "one" }, { type: "stop", reason: "stop" }]],
      { id: "scripted-strict", onExhausted: "throw", maxStoredRequests: 2 }
    );

    const first = new AgentRuntime({ cwd: "C:/repo", provider });
    await runRuntimeWithProbe(first, "a");
    expect(provider.callCount).toBe(1);
    expect(provider.getRequests()).toHaveLength(1);
    expect(provider.getRequests()[0]?.messages.length).toBeGreaterThan(0);

    const second = new AgentRuntime({ cwd: "C:/repo", provider });
    const exhausted = await runRuntimeWithProbe(second, "b");
    // Runtime surfaces stream failures as runtime-error / agent-end rather than rejecting the probe.
    expect(exhausted.report.errors.join("\n")).toMatch(/exhausted after 1 step/);
    expect(provider.callCount).toBe(2);

    provider.reset();
    expect(provider.callCount).toBe(0);
    expect(provider.getRequests()).toHaveLength(0);

    const emptyOnExhaust = createScriptedProvider(
      [[{ type: "text-delta", text: "only" }, { type: "stop", reason: "stop" }]],
      { onExhausted: "empty" }
    );
    const r1 = new AgentRuntime({ cwd: "C:/repo", provider: emptyOnExhaust });
    await runRuntimeWithProbe(r1, "x");
    expect(emptyOnExhaust.callCount).toBeGreaterThanOrEqual(1);
    const afterFirst = emptyOnExhaust.callCount;
    const r2 = new AgentRuntime({ cwd: "C:/repo", provider: emptyOnExhaust });
    // Exhausted steps yield empty streams; runtime may retry, but must not throw.
    const emptyProbe = await runRuntimeWithProbe(r2, "y");
    expect(emptyOnExhaust.callCount).toBeGreaterThan(afterFirst);
    expect(emptyProbe.report.eventCount).toBeGreaterThan(0);
  });

  it("createScriptedTextProvider yields stop-terminated replies", async () => {
    const provider = createScriptedTextProvider(["hello", "world"], "text-script");
    const runtime = new AgentRuntime({ cwd: "C:/repo", provider });
    const first = await runRuntimeWithProbe(runtime, "hi");
    expect(first.messages.at(-1)?.blocks.some((b) => b.type === "text" && b.text.includes("hello"))).toBe(true);

    const runtime2 = new AgentRuntime({ cwd: "C:/repo", provider });
    const second = await runRuntimeWithProbe(runtime2, "again");
    expect(second.messages.at(-1)?.blocks.some((b) => b.type === "text" && b.text.includes("world"))).toBe(true);
    expect(provider.callCount).toBe(2);
    expect(provider.id).toBe("text-script");
  });

  it("records abortReason without treating abort as a hard error", async () => {
    const write = createWriteFileTool({ workspaceRoot });
    const provider = createScriptedProvider([
      [
        { type: "tool-call", id: "call_write", toolName: "write_file", input: { path: "early.txt", content: "ok" } },
        { type: "stop", reason: "tool-call" }
      ],
      [
        { type: "tool-call", id: "call_extra", toolName: "write_file", input: { path: "late.txt", content: "no" } },
        { type: "stop", reason: "tool-call" }
      ]
    ]);

    const suite = await runRuntimeStageSuite({
      workspaceRoot,
      stages: [
        {
          name: "abort-ok",
          prompt: "write early.txt",
          requiredFiles: ["early.txt"],
          requiredToolCallCounts: { write_file: 1 },
          stopWhenRequirementsMet: true
        }
      ],
      createRuntime() {
        return new AgentRuntime({
          cwd: workspaceRoot,
          provider,
          tools: [write],
          permissionPolicy: allowAllPermissionPolicy
        });
      }
    });

    expect(suite.errors).toEqual([]);
    expect(suite.stages[0]?.report.abortReason).toBe("stage requirements met");
    expect(suite.stages[0]?.report.errors).toEqual([]);
    const summary = summarizeRuntimeProbeReport(suite.stages[0]!.report);
    expect(summary).toContain("abort=");
    expect(summary).toContain("tools=write_file×1");
  });

  it("evaluates assistant includes and path-escape file checks as soft requirement failures", async () => {
    const provider = createScriptedTextProvider(["assistant says ALPHA-MARKER"]);
    const runtime = new AgentRuntime({ cwd: workspaceRoot, provider });
    const probe = await runRuntimeWithProbe(runtime, "speak");

    const requirements = await evaluateRuntimeStageRequirements(
      {
        name: "check",
        prompt: "x",
        requiredAssistantIncludes: ["ALPHA-MARKER", "missing-token"],
        requiredFiles: ["../escape.txt"]
      },
      probe.report,
      { workspaceRoot, messages: probe.messages }
    );

    expect(requirements.find((r) => r.kind === "assistant" && r.target.includes("ALPHA-MARKER"))?.passed).toBe(true);
    expect(requirements.find((r) => r.kind === "assistant" && r.target.includes("missing-token"))?.passed).toBe(false);
    const escape = requirements.find((r) => r.kind === "file" && r.target === "../escape.txt");
    expect(escape?.passed).toBe(false);
    expect(escape?.reason).toMatch(/Path escapes workspace/i);
    expect(stageRequirementsPassed(requirements)).toBe(false);
  });

  it("enforces maxErrors on probe error collection", async () => {
    const tool = defineTextTool({
      name: "fail_tool",
      description: "Always fails",
      category: "terminal",
      readOnly: true,
      execute: () => {
        throw new Error("boom");
      }
    });
    const provider = createScriptedProvider([
      [
        { type: "tool-call", id: "c1", toolName: "fail_tool", input: {} },
        { type: "tool-call", id: "c2", toolName: "fail_tool", input: {} },
        { type: "tool-call", id: "c3", toolName: "fail_tool", input: {} },
        { type: "stop", reason: "tool-call" }
      ],
      [{ type: "text-delta", text: "done" }, { type: "stop", reason: "stop" }]
    ]);
    const runtime = new AgentRuntime({
      cwd: workspaceRoot,
      provider,
      tools: [tool]
    });

    const result = await runRuntimeWithProbe(runtime, "fail thrice", { maxErrors: 2 });
    expect(result.report.errors.length).toBeLessThanOrEqual(2);
    expect(result.report.toolCallCount).toBe(3);
  });

  it("formats stage suite results and continues when stopOnRequirementFailure is false", async () => {
    const provider = createScriptedTextProvider(["no tools here", "second stage"]);
    const suite = await runRuntimeStageSuite({
      workspaceRoot,
      stopOnRequirementFailure: false,
      stages: [
        { name: "weak", prompt: "try", requiredToolCalls: ["write_file"] },
        { name: "next", prompt: "continue", requiredAssistantIncludes: ["second"] }
      ],
      createRuntime({ index }) {
        return new AgentRuntime({
          cwd: workspaceRoot,
          provider: index === 0 ? createScriptedTextProvider(["no tools here"]) : createScriptedTextProvider(["second stage"])
        });
      }
    });

    expect(suite.completedStageCount).toBe(2);
    expect(suite.stoppedAtStage).toBeUndefined();
    expect(suite.errors.join("\n")).toContain("write_file");
    const formatted = formatRuntimeStageSuiteResult(suite);
    expect(formatted).toContain("stages=2/2");
    expect(formatted).toContain("weak");
    expect(formatted).toContain("next");
    expect(formatted).toContain("errorDetails:");
  });

  it("passes stage when requiredAssistantIncludes is satisfied", async () => {
    const suite = await runRuntimeStageSuite({
      stages: [
        {
          name: "speak",
          prompt: "say ready",
          requiredAssistantIncludes: ["ready"]
        }
      ],
      createRuntime() {
        return new AgentRuntime({
          cwd: workspaceRoot,
          provider: createScriptedTextProvider(["all systems ready"])
        });
      }
    });

    expect(suite.errors).toEqual([]);
    expect(suite.stages[0]?.requirements.every((r) => r.passed)).toBe(true);
    expect(stageRequirementsPassed(suite.stages[0]!.requirements)).toBe(true);
  });
});

