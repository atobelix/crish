import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createScriptedProvider, createPermissionPolicy } from "@crish/agent-runtime";
import { createDefaultWorkbenchSettings } from "../shared/workbench-config";
import { createWorkbenchRuntime } from "./runtime-factory";
import { runWorkbenchTask } from "./workbench-runner";
import type { WorkbenchTaskSnapshot } from "../shared/workbench-contract";

let workspaceRoot = "";

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "agent-workbench-runner-"));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe("workbench runner", () => {
  it("maps real agent runtime events into workbench events and disclosure suggestions", async () => {
    const provider = createScriptedProvider([
      [
        { type: "text-delta", text: "输出图片：![结果](output/a.png)" },
        { type: "stop", reason: "stop" }
      ]
    ]);
    const runtime = await createWorkbenchRuntime(runtimeOpts({
      cwd: workspaceRoot,
      settings: testSettings(),
      provider,
      permissionPolicy: createPermissionPolicy({ mode: "full-access" })
    }));
    const events = [];
    let finalSnapshot;

    for await (const item of runWorkbenchTask(runnerOpts({
      runtime,
      cwd: workspaceRoot,
      prompt: "生成中文界面检查结果"
    }))) {
      events.push(item.event);
      finalSnapshot = item.snapshot;
    }

    expect(events.map((event) => event.type)).toContain("message-update");
    expect(events.map((event) => event.type)).toContain("disclosure-suggestion");
    expect(finalSnapshot?.outputReferences).toHaveLength(1);
    expect(finalSnapshot?.disclosureIssues.map((issue) => issue.kind)).toEqual(["relative-path"]);
  });

  it("keeps listening for background command completion and emits resume request", async () => {
    const provider = createScriptedProvider([
      [
        {
          type: "tool-call",
          id: "call_bg",
          toolName: "run_background",
          input: {
            command: "node -e \"setTimeout(() => console.log('后台完成'), 80)\"",
            timeoutMs: 2_000
          }
        },
        { type: "stop", reason: "tool-call" }
      ]
    ]);
    const runtime = await createWorkbenchRuntime(runtimeOpts({
      cwd: workspaceRoot,
      settings: testSettings(),
      provider,
      maxTurns: 1,
      permissionPolicy: createPermissionPolicy({ mode: "full-access" })
    }));
    const events = [];
    let finalSnapshot;

    for await (const item of runWorkbenchTask(runnerOpts({
      runtime,
      cwd: workspaceRoot,
      prompt: "启动后台检查",
      backgroundDrainTimeoutMs: 2_000
    }))) {
      events.push(item.event);
      finalSnapshot = item.snapshot;
    }

    expect(events.map((event) => event.type)).toContain("background-task-start");
    expect(events.map((event) => event.type)).toContain("background-task-end");
    expect(events.map((event) => event.type)).toContain("resume-requested");
    expect(finalSnapshot?.backgroundTasks[0]).toMatchObject({
      state: "succeeded",
      exitCode: 0
    });
  });

  it("stops safely when the per-prompt run token budget is reached", async () => {
    const provider = createScriptedProvider([
      [
        {
          type: "tool-call",
          id: "call_budget",
          toolName: "shell_command",
          input: {
            command: "node -e \"console.log('should-not-run')\""
          }
        },
        {
          type: "stop",
          reason: "tool-call",
          usage: {
            promptTokens: 70,
            completionTokens: 50,
            totalTokens: 120
          }
        }
      ],
      [
        { type: "text-delta", text: "unexpected" },
        { type: "stop", reason: "stop", usage: { totalTokens: 10 } }
      ]
    ]);
    const runtime = await createWorkbenchRuntime(runtimeOpts({
      cwd: workspaceRoot,
      settings: testSettings(),
      provider,
      maxTurns: 4,
      permissionPolicy: createPermissionPolicy({ mode: "full-access" })
    }));
    const events = [];
    let finalSnapshot;

    for await (const item of runWorkbenchTask(runnerOpts({
      runtime,
      cwd: workspaceRoot,
      prompt: "\u6d4b\u8bd5\u5355\u6b21\u4efb\u52a1 token \u9884\u7b97",
      runBudget: {
        enabled: undefined,
        difficulty: undefined,
        maxTotalTokens: 100,
        warnAtRatio: 0.5
      }
    }))) {
      events.push(item.event);
      finalSnapshot = item.snapshot;
    }

    expect(events.map((event) => event.type)).toContain("health-update");
    expect(events.map((event) => event.type)).toContain("progress-update");
    expect(
      events.some((event) => {
        const payload = event.payload as { result?: { toolName?: string } } | undefined;
        return payload?.result?.toolName === "shell_command";
      })
    ).toBe(false);
    expect(finalSnapshot?.evidence.map((item) => item.id)).toEqual(["evidence-scope", "evidence-no-file-changes"]);
    expect(finalSnapshot?.evidence.some((item) => item.id.startsWith("tool-"))).toBe(false);
    expect(finalSnapshot?.tokenBudget).toMatchObject({
      usedTotalTokens: 120,
      requestCount: 1,
      warned: true,
      reached: true
    });
  });

  it("records disclosure issues from failed command tool results", async () => {
    const provider = createScriptedProvider([
      [
        {
          type: "tool-call",
          id: "call_failed_command",
          toolName: "shell_command",
          input: {
            command: "node -e \"process.exit(1)\"",
            timeoutMs: 2_000
          }
        },
        { type: "stop", reason: "tool-call" }
      ]
    ]);
    const runtime = await createWorkbenchRuntime(runtimeOpts({
      cwd: workspaceRoot,
      settings: testSettings(),
      provider,
      maxTurns: 1,
      permissionPolicy: createPermissionPolicy({ mode: "full-access" })
    }));
    const events = [];
    let finalSnapshot;

    for await (const item of runWorkbenchTask(runnerOpts({
      runtime,
      cwd: workspaceRoot,
      prompt: "\u8fd0\u884c\u547d\u4ee4\u8bca\u65ad"
    }))) {
      events.push(item.event);
      finalSnapshot = item.snapshot;
    }

    expect(events.map((event) => event.type)).toContain("disclosure-suggestion");
    expect(finalSnapshot?.disclosureIssues.map((issue) => issue.kind)).toContain("command-failed");
    expect(finalSnapshot?.evidence.find((item) => item.id === "tool-call_failed_command")?.metadata).toMatchObject({
      toolName: "shell_command",
      isError: false,
      command: 'node -e "process.exit(1)"',
      exitCode: 1
    });
  });

  it("records edit checkpoints as workbench changes", async () => {
    await writeFile(join(workspaceRoot, "a.txt"), "old\n", "utf8");
    const provider = createScriptedProvider([
      [
        {
          type: "tool-call",
          id: "call_edit",
          toolName: "edit",
          input: {
            path: "a.txt",
            content: "new\n"
          }
        },
        { type: "stop", reason: "tool-call" }
      ],
      [
        { type: "text-delta", text: "done" },
        { type: "stop", reason: "stop" }
      ]
    ]);
    const runtime = await createWorkbenchRuntime(runtimeOpts({
      cwd: workspaceRoot,
      settings: testSettings(),
      provider,
      maxTurns: 3,
      permissionPolicy: createPermissionPolicy({ mode: "full-access" })
    }));
    const events = [];
    let finalSnapshot;

    for await (const item of runWorkbenchTask(runnerOpts({
      runtime,
      cwd: workspaceRoot,
      prompt: "edit a file"
    }))) {
      events.push(item.event);
      finalSnapshot = item.snapshot;
    }

    expect(events.map((event) => event.type)).toContain("checkpoint-created");
    expect(finalSnapshot?.changes).toContainEqual(
      expect.objectContaining({
        path: "a.txt",
        state: "draft",
        additions: 1,
        deletions: 1,
        checkpointId: expect.any(String)
      })
    );
    expect(finalSnapshot?.acceptance.find((item) => item.id === "changes-tracked")).toMatchObject({
      passed: true
    });
  });

  it("marks the task done only after inspection, change tracking, verification, and final review evidence", async () => {
    await writeFile(join(workspaceRoot, "a.js"), "console.log('old')\n", "utf8");
    const provider = createScriptedProvider([
      [
        {
          type: "tool-call",
          id: "call_read",
          toolName: "read_file",
          input: {
            path: "a.js"
          }
        },
        { type: "stop", reason: "tool-call" }
      ],
      [
        {
          type: "tool-call",
          id: "call_edit",
          toolName: "edit",
          input: {
            path: "a.js",
            content: "console.log('new')\n"
          }
        },
        { type: "stop", reason: "tool-call" }
      ],
      [
        {
          type: "tool-call",
          id: "call_check",
          toolName: "shell_command",
          input: {
            command: "node --check a.js",
            timeoutMs: 2_000
          }
        },
        { type: "stop", reason: "tool-call" }
      ],
      [
        { type: "text-delta", text: "已完成修改，并通过语法检查确认结果。" },
        { type: "stop", reason: "stop" }
      ]
    ]);
    const runtime = await createWorkbenchRuntime(runtimeOpts({
      cwd: workspaceRoot,
      settings: testSettings(),
      provider,
      maxTurns: 3,
      permissionPolicy: createPermissionPolicy({ mode: "full-access" })
    }));
    let finalSnapshot: WorkbenchTaskSnapshot | undefined;

    for await (const item of runWorkbenchTask(runnerOpts({
      runtime,
      cwd: workspaceRoot,
      prompt: "edit a file"
    }))) {
      finalSnapshot = item.snapshot;
    }

    expect(finalSnapshot?.state).toBe("done");
    expect(finalSnapshot?.completionPercent).toBe(100);
    expect(finalSnapshot?.plan.map((item) => item.state)).toEqual(["done", "done", "done", "done"]);
    expect(finalSnapshot?.acceptance.every((item) => item.passed)).toBe(true);
    expect(finalSnapshot?.acceptance.find((item) => item.id === "checks-run")?.evidenceIds).toContain("tool-call_check");
    expect(finalSnapshot?.acceptance.find((item) => item.id === "result-reviewed")?.evidenceIds[0]).toMatch(/^evidence-review-/);
  });

  it("marks read-only inspection tasks done without forcing a verification command", async () => {
    await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({ name: "demo-project" }), "utf8");
    const provider = createScriptedProvider([
      [
        {
          type: "tool-call",
          id: "call_list",
          toolName: "list_directory",
          input: {
            path: "."
          }
        },
        { type: "stop", reason: "tool-call" }
      ],
      [
        {
          type: "tool-call",
          id: "call_read",
          toolName: "read_file",
          input: {
            path: "package.json"
          }
        },
        { type: "stop", reason: "tool-call" }
      ],
      [
        {
          type: "text-delta",
          text: "\u5df2\u5b8c\u6210\u53ea\u8bfb\u68c0\u67e5\uff1a\u9879\u76ee\u540d\u79f0\u662f demo-project\uff0c\u672a\u5199\u5165\u6587\u4ef6\u3002"
        },
        { type: "stop", reason: "stop" }
      ]
    ]);
    const runtime = await createWorkbenchRuntime(runtimeOpts({
      cwd: workspaceRoot,
      settings: testSettings(),
      provider,
      maxTurns: 5,
      permissionPolicy: createPermissionPolicy({ mode: "full-access" })
    }));
    let finalSnapshot;

    for await (const item of runWorkbenchTask(runnerOpts({
      runtime,
      cwd: workspaceRoot,
      prompt: "\u8bf7\u53ea\u8bfb\u68c0\u67e5\u6839\u76ee\u5f55\u548c package.json\uff0c\u4e0d\u4fee\u6539\u6587\u4ef6"
    }))) {
      finalSnapshot = item.snapshot;
    }

    expect(finalSnapshot?.state).toBe("done");
    expect(finalSnapshot?.changes).toEqual([]);
    expect(finalSnapshot?.plan.map((item) => item.state)).toEqual(["done", "done", "done", "done"]);
    expect(finalSnapshot?.acceptance.every((item) => item.passed)).toBe(true);
    expect(finalSnapshot?.acceptance.find((item) => item.id === "checks-run")?.evidenceIds[0]).toMatch(/^evidence-review-/);
  });

  it("does not treat arbitrary successful commands as verification evidence", async () => {
    const provider = createScriptedProvider([
      [
        {
          type: "tool-call",
          id: "call_echo",
          toolName: "shell_command",
          input: {
            command: "node -e \"console.log('ok')\"",
            timeoutMs: 2_000
          }
        },
        { type: "stop", reason: "tool-call" }
      ],
      [
        { type: "text-delta", text: "命令已经成功运行。" },
        { type: "stop", reason: "stop" }
      ]
    ]);
    const runtime = await createWorkbenchRuntime(runtimeOpts({
      cwd: workspaceRoot,
      settings: testSettings(),
      provider,
      maxTurns: 8,
      permissionPolicy: createPermissionPolicy({ mode: "full-access" })
    }));
    let finalSnapshot;

    for await (const item of runWorkbenchTask(runnerOpts({
      runtime,
      cwd: workspaceRoot,
      prompt: "修改 a.js 并完成检查"
    }))) {
      finalSnapshot = item.snapshot;
    }

    expect(finalSnapshot?.state).not.toBe("done");
    expect(finalSnapshot?.acceptance.find((item) => item.id === "checks-run")?.passed).toBe(false);
    expect(finalSnapshot?.acceptance.find((item) => item.id === "result-reviewed")?.passed).toBe(false);
  });

  it("marks restored checkpoint changes as checked", async () => {
    await writeFile(join(workspaceRoot, "a.txt"), "old\n", "utf8");
    let manifestPath = "";
    const provider = createScriptedProvider([
      [
        {
          type: "tool-call",
          id: "call_checkpoint",
          toolName: "create_workspace_checkpoint",
          input: {
            label: "before edit",
            files: ["a.txt"]
          }
        },
        { type: "stop", reason: "tool-call" }
      ],
      (request) => {
        manifestPath = latestToolJsonField(request.messages, "manifestPath") ?? "";
        return [
          {
            type: "tool-call",
            id: "call_edit",
            toolName: "edit",
            input: {
              path: "a.txt",
              content: "new\n"
            }
          },
          { type: "stop", reason: "tool-call" }
        ];
      },
      () => [
        {
          type: "tool-call",
          id: "call_restore",
          toolName: "restore_workspace_checkpoint",
          input: {
            checkpointPath: manifestPath
          }
        },
        { type: "stop", reason: "tool-call" }
      ],
      [
        { type: "text-delta", text: "done" },
        { type: "stop", reason: "stop" }
      ]
    ]);
    const runtime = await createWorkbenchRuntime(runtimeOpts({
      cwd: workspaceRoot,
      settings: testSettings(),
      provider,
      maxTurns: 6,
      permissionPolicy: createPermissionPolicy({ mode: "full-access" })
    }));
    const events = [];
    let finalSnapshot;

    for await (const item of runWorkbenchTask(runnerOpts({
      runtime,
      cwd: workspaceRoot,
      prompt: "edit then restore a file"
    }))) {
      events.push(item.event);
      finalSnapshot = item.snapshot;
    }

    expect(events.map((event) => event.type)).toContain("change-update");
    expect(await readFile(join(workspaceRoot, "a.txt"), "utf8")).toBe("old\n");
    expect(finalSnapshot?.changes).toContainEqual(
      expect.objectContaining({
        path: "a.txt",
        state: "checked",
        additions: 1,
        deletions: 1,
        checkpointId: expect.any(String)
      })
    );
  });
});

function runtimeOpts(overrides: {
  cwd: string;
  settings: ReturnType<typeof testSettings>;
  provider?: import("@crish/agent-runtime").AgentProvider;
  maxTurns?: number;
  permissionPolicy?: import("@crish/agent-runtime").RuntimePermissionPolicy;
}): import("./runtime-factory").WorkbenchRuntimeFactoryOptions {
  return {
    configPath: undefined,
    sessionPath: undefined,
    apiKey: undefined,
    resumeSession: undefined,
    provider: undefined,
    maxTurns: undefined,
    permissionPolicy: undefined,
    ...overrides
  };
}

function runnerOpts(overrides: {
  runtime: import("./runtime-factory").WorkbenchRuntimeFactoryResult;
  cwd: string;
  prompt: string;
  backgroundDrainTimeoutMs?: number;
  runBudget?: import("./workbench-runner").WorkbenchRunnerBudgetOptions;
}): import("./workbench-runner").WorkbenchRunnerOptions {
  return {
    mode: undefined,
    initialSnapshot: undefined,
    backgroundDrainTimeoutMs: undefined,
    runBudget: undefined,
    ...overrides
  };
}

function testSettings() {
  const settings = createDefaultWorkbenchSettings();
  return {
    ...settings,
    provider: {
      ...settings.provider,
      model: {
        ...settings.provider.model,
        id: "scripted-model"
      }
    }
  };
}

function latestToolJsonField(messages: Array<{ blocks: Array<{ type: string; output?: { json?: unknown } }> }>, field: string): string | undefined {
  for (const message of [...messages].reverse()) {
    for (const block of [...message.blocks].reverse()) {
      if (block.type !== "tool-result") continue;
      const json = block.output?.json;
      if (!json || typeof json !== "object" || Array.isArray(json)) continue;
      const value = (json as Record<string, unknown>)[field];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return undefined;
}
