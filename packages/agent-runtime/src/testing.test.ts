import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentRuntime,
  createScriptedProvider,
  createWriteFileTool,
  defineTextTool,
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
          initialMessages
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
          tools: [createWriteFileTool({ workspaceRoot })]
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
          tools: [write]
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
          tools: [write]
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
          initialMessages
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
});
