import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createApplyWorkspaceEditsTool,
  createBackgroundCommandTools,
  createEditTool,
  GitCliVersioningService,
  createListDirectoryTool,
  createLocalWorkspaceTools,
  createReadTool,
  createReadFileTool,
  createRestoreFileSnapshotTool,
  createRestoreWorkspaceCheckpointTool,
  createSearchFilesTool,
  createTerminalCommandTool,
  BackgroundCommandManager,
  WorkspaceMutationCoordinator,
  createWorkspaceCheckpointTool,
  createWriteFileTool
} from ".";
import { encodeTextBuffer } from "./encoding";
import type { ToolExecutionContext } from "@crish/shared-types";
import type { AgentTool } from "./types";

const execFileAsync = promisify(execFile);

let workspaceRoot = "";

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "agent-runtime-"));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    toolCallId: "call",
    sessionId: "session",
    cwd: workspaceRoot,
    signal: new AbortController().signal,
    emit: () => undefined,
    ...overrides
  };
}

async function waitForBackgroundTaskState(
  check: AgentTool,
  taskId: string,
  state: string,
): Promise<{ state?: string }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const output = await check.execute({ taskId }, context());
    const json = output.json as { state?: string };
    if (json.state === state) return json;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for background command ${taskId} to reach ${state}`);
}

function taskTools(workspaceRoot: string) {
  const manager = new BackgroundCommandManager({
    workspaceRoot,
    defaultTimeoutMs: 10_000,
  });
  const tools = createBackgroundCommandTools(manager);
  return {
    manager,
    run: tools.find((t) => t.name === "run_background")!,
    wait: tools.find((t) => t.name === "wait_for_task")!,
    check: tools.find((t) => t.name === "check_task")!,
    list: tools.find((t) => t.name === "list_tasks")!,
    stop: tools.find((t) => t.name === "stop_task")!,
  };
}

async function git(args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: workspaceRoot });
}

async function initGitRepo(): Promise<void> {
  await git(["init"]);
  await git(["config", "user.name", "Conex Test"]);
  await git(["config", "user.email", "conex-test@example.test"]);
  await writeFile(join(workspaceRoot, "base.txt"), "base", "utf8");
  await git(["add", "base.txt"]);
  await git(["commit", "-m", "initial"]);
}

describe("local workspace tools", () => {
  it("runs terminal commands and returns structured output", async () => {
    const tool = createTerminalCommandTool({ workspaceRoot, defaultTimeoutMs: 10_000 });
    const output = await tool.execute({ command: 'node -e "console.log(123)"' }, context());

    // Tool text is stdout/stderr only; exit metadata lives in json for the UI.
    expect(output.text).toContain("123");
    expect(output.text).not.toMatch(/Exit code:/);
    expect(output.json).toMatchObject({ exitCode: 0 });
  });

  it("propagates native command exit codes through the shell wrapper", async () => {
    const tool = createTerminalCommandTool({ workspaceRoot, defaultTimeoutMs: 10_000 });
    const output = await tool.execute({ command: 'node -e "process.exit(7)"' }, context());

    expect(output.json).toMatchObject({ exitCode: 7 });
  });

  it("returns typed foreground timeout state with termination diagnostics", async () => {
    const tool = createTerminalCommandTool({ workspaceRoot, defaultTimeoutMs: 100 });
    const output = await tool.execute({ command: 'node -e "setTimeout(() => {}, 30000)"' }, context());
    const json = output.json as {
      timedOut?: boolean;
      cancelled?: boolean;
      exitCode?: number | null;
      signal?: string | null;
      terminationDiagnostics?: Array<{ strategy?: string; ok?: boolean }>;
    };

    expect(output.text).toMatch(/命令超时|timed out/i);
    expect(json.timedOut).toBe(true);
    expect(json.cancelled).toBe(false);
    expect(json.exitCode ?? json.signal).not.toBeUndefined();
    expect(json.terminationDiagnostics?.length).toBeGreaterThan(0);
    expect(json.terminationDiagnostics?.[0]).toMatchObject({ ok: expect.any(Boolean) });
  }, 10_000);

  it("returns typed foreground cancellation state", async () => {
    const abortController = new AbortController();
    const tool = createTerminalCommandTool({ workspaceRoot, defaultTimeoutMs: 10_000 });
    const running = tool.execute({ command: 'node -e "setTimeout(() => {}, 30000)"' }, context({ signal: abortController.signal }));

    setTimeout(() => abortController.abort(), 100);
    const output = await running;
    const json = output.json as { timedOut?: boolean; cancelled?: boolean; terminationDiagnostics?: unknown[] };

    expect(output.text).toMatch(/已取消|cancel/i);
    expect(json).toMatchObject({ timedOut: false, cancelled: true });
    expect(json.terminationDiagnostics?.length).toBeGreaterThan(0);
  }, 10_000);

  it("spills large foreground output into a bounded preview with byte metadata", async () => {
    const tool = createTerminalCommandTool({ workspaceRoot, defaultTimeoutMs: 10_000, maxOutputBytes: 1_500 });
    const output = await tool.execute({ command: 'node -e "process.stdout.write(\'a\'.repeat(8000))"' }, context());
    const json = output.json as { stdout?: string; stdoutBytes?: number; truncated?: boolean; outputPreview?: string };

    expect(json.truncated).toBe(true);
    expect(json.stdoutBytes).toBe(8000);
    expect(json.stdout?.length).toBeLessThan(3000);
    expect(json.stdout).toContain("[output omitted:");
    expect(json.outputPreview).toContain("[output omitted:");
  });

  it("runs common chained commands through the default shell wrapper", async () => {
    const tool = createTerminalCommandTool({ workspaceRoot, defaultTimeoutMs: 10_000 });
    const output = await tool.execute(
      { command: 'node -e "process.stdout.write(\'first\')" && node -e "process.stdout.write(\'second\')"' },
      context()
    );

    expect(output.text).toContain("firstsecond");
    expect(output.json).toMatchObject({ exitCode: 0 });
  });

  it("preserves Chinese terminal output through the shell wrapper", async () => {
    const tool = createTerminalCommandTool({ workspaceRoot, defaultTimeoutMs: 10_000 });
    const output = await tool.execute({ command: 'node -e "console.log(\'中文探针\')"' }, context());

    expect(output.text).toContain("中文探针");
    expect(output.json).toMatchObject({ exitCode: 0, stdout: "中文探针\n" });
  });

  it("blocks hardline terminal commands below the approval layer", async () => {
    const tool = createTerminalCommandTool({ workspaceRoot, defaultTimeoutMs: 10_000 });
    await expect(tool.execute({ command: "shutdown /s" }, context())).rejects.toThrow(/hardline|shutdown|reboot/i);
  });

  it("scrubs sensitive environment variables from terminal commands", async () => {
    const scriptPath = join(workspaceRoot, "env-check.js");
    await writeFile(scriptPath, "console.log(process.env.AGENT_RUNTIME_TEST_TOKEN || 'none')", "utf8");
    process.env.AGENT_RUNTIME_TEST_TOKEN = "secret-value";
    const tool = createTerminalCommandTool({ workspaceRoot, defaultTimeoutMs: 10_000 });

    try {
      const output = await tool.execute({ command: "node env-check.js" }, context());
      expect(output.text).toContain("none");
      expect(output.text).not.toContain("secret-value");
    } finally {
      delete process.env.AGENT_RUNTIME_TEST_TOKEN;
    }
  });

  it("runs background lifecycle through clear task tools", async () => {
    await writeFile(join(workspaceRoot, "bg-tool.js"), "setTimeout(() => console.log('done'), 30000);", "utf8");
    const { run, list, check, stop } = taskTools(workspaceRoot);

    const started = await run.execute({ command: "node bg-tool.js" }, context());
    const taskId = (started.json as { id: string }).id;
    const listed = await list.execute({}, context());
    const status = await check.execute({ taskId }, context());
    const cancel = await stop.execute({ taskId }, context());
    const cancelled = await waitForBackgroundTaskState(check, taskId, "cancelled");

    expect(started.text).toMatch(/后台任务已启动|后台/);
    expect(taskId).toMatch(/^bgcmd-/);
    expect(listed.text).toContain(taskId);
    expect(status.text).toContain(taskId);
    expect(cancel.text).toMatch(/停止|取消/);
    expect(cancelled).toMatchObject({ state: "cancelled" });
  }, 15_000);

  it("shell_command redirects legacy background=true to run_background", async () => {
    const tool = createTerminalCommandTool({ workspaceRoot, defaultTimeoutMs: 10_000 });
    const output = await tool.execute({ command: "echo hi", background: true } as any, context());
    expect(output.text).toMatch(/run_background/);
    expect((output.json as { redirected?: boolean }).redirected).toBe(true);
  });

  it("does not lock read-only shell commands even when a workspace lease is active", async () => {
    const mutationCoordinator = new WorkspaceMutationCoordinator({ workspaceRoot });
    const active = await mutationCoordinator.acquire({ scope: { type: "workspace" } });
    expect(active.ok).toBe(true);
    const tool = createTerminalCommandTool({ workspaceRoot, mutationCoordinator, defaultTimeoutMs: 10_000 });

    try {
      const output = await tool.execute({ command: "pwd" }, context());
      // Read-only shell must not block on the workspace lease; json carries success.
      expect(output.json).toMatchObject({ exitCode: 0 });
    } finally {
      if (active.ok) mutationCoordinator.release(active.lease.token);
    }
  });

  it("does not create pre-mutation git checkpoints for read-only or benign shell commands", async () => {
    const checkpointed: string[] = [];
    const tool = createTerminalCommandTool({
      workspaceRoot,
      defaultTimeoutMs: 15_000,
      preMutationCheckpoint: {
        hook: async (request) => {
          checkpointed.push(request.targetSummary);
          return { status: "skipped", reason: "test-should-not-run" };
        }
      }
    });

    const readonlyCommands = [
      "echo hello",
      "ping -n 1 127.0.0.1",
      process.platform === "win32" ? "dir" : "ls",
      process.platform === "win32" ? "Get-ChildItem" : "ls -la",
      "git status",
      "git log -1 --oneline",
      "git diff --stat"
    ];

    for (const command of readonlyCommands) {
      const output = await tool.execute({ command }, context());
      expect(output.text, command).not.toMatch(/Pre-mutation Git checkpoint/);
      expect((output.json as { preMutationCheckpoint?: unknown }).preMutationCheckpoint, command).toBeUndefined();
    }
    expect(checkpointed).toEqual([]);
  }, 60_000);

  it("creates pre-mutation checkpoints for mutating shell commands and omits skipped diagnostics from text", async () => {
    let hookCalls = 0;
    const tool = createTerminalCommandTool({
      workspaceRoot,
      defaultTimeoutMs: 15_000,
      preMutationCheckpoint: {
        hook: async () => {
          hookCalls += 1;
          return { status: "skipped", reason: "test-skip-quiet" };
        }
      }
    });

    const output = await tool.execute(
      {
        command: process.platform === "win32" ? "echo hi > shell-mutate.txt" : "echo hi > shell-mutate.txt"
      },
      context()
    );

    expect(hookCalls).toBe(1);
    expect(output.text).not.toMatch(/Pre-mutation Git checkpoint/);
    expect((output.json as { preMutationCheckpoint?: { status?: string; reason?: string } }).preMutationCheckpoint).toMatchObject({
      status: "skipped",
      reason: "test-skip-quiet"
    });
  });

  it("wraps foreground mutating shell commands in a workspace lease and releases on failure", async () => {
    const mutationCoordinator = new WorkspaceMutationCoordinator({ workspaceRoot });
    const observedLeases = [] as ReturnType<WorkspaceMutationCoordinator["listLeases"]>;
    const tool = createTerminalCommandTool({
      workspaceRoot,
      mutationCoordinator,
      defaultTimeoutMs: 10_000,
      preMutationCheckpoint: {
        onFailure: "throw",
        hook: () => {
          observedLeases.push(...mutationCoordinator.listLeases());
          throw new Error("checkpoint hook failed");
        }
      }
    });

    await expect(tool.execute({ command: "echo hi > shell-lease.txt" }, context())).rejects.toThrow("checkpoint hook failed");
    expect(observedLeases).toHaveLength(1);
    expect(observedLeases[0]).toMatchObject({
      owner: {
        sessionId: "session",
        toolCallId: "call",
        toolName: "shell_command",
        cwd: workspaceRoot
      },
      scope: { type: "workspace" }
    });
    expect(observedLeases[0]?.owner?.targetSummary).toContain("echo hi > shell-lease.txt");
    expect(mutationCoordinator.listLeases()).toEqual([]);
  });

  it("background task tools do not hold workspace leases", async () => {
    const mutationCoordinator = new WorkspaceMutationCoordinator({ workspaceRoot });
    // leases are only for mutating foreground shell; task tools are separate
    const { run, list, check, stop } = taskTools(workspaceRoot);

    const started = await run.execute(
      { command: 'node -e "setTimeout(() => {}, 30000)"' },
      context(),
    );
    const taskId = (started.json as { id: string }).id;
    expect(mutationCoordinator.listLeases()).toEqual([]);

    await list.execute({}, context());
    expect(mutationCoordinator.listLeases()).toEqual([]);

    await check.execute({ taskId }, context());
    expect(mutationCoordinator.listLeases()).toEqual([]);

    await stop.execute({ taskId }, context());
    expect(mutationCoordinator.listLeases()).toEqual([]);
    await waitForBackgroundTaskState(check, taskId, "cancelled");
    expect(mutationCoordinator.listLeases()).toEqual([]);
  }, 15_000);

  it("createLocalWorkspaceTools exposes both shell_command and task tools", () => {
    const tools = createLocalWorkspaceTools({ workspaceRoot });
    const names = tools.map((t) => t.name);
    expect(names).toContain("shell_command");
    expect(names).toContain("run_background");
    expect(names).toContain("wait_for_task");
    expect(names).toContain("check_task");
    expect(names).toContain("stop_task");
    expect(names).toContain("list_tasks");
  });

  it("reads, writes, lists, and searches files inside the workspace", async () => {
    const write = createWriteFileTool({ workspaceRoot });
    const read = createReadFileTool({ workspaceRoot });
    const list = createListDirectoryTool({ workspaceRoot });
    const search = createSearchFilesTool({ workspaceRoot });

    const writeOutput = await write.execute({ path: "notes/a.txt", content: "alpha\nbeta" }, context());

    await expect(readFile(join(workspaceRoot, "notes", "a.txt"), "utf8")).resolves.toBe("alpha\nbeta");
    expect(writeOutput.text).toContain("Result preview (actual file");
    expect(writeOutput.text).toContain("1 | alpha");
    expect(writeOutput.text).toContain("2 | beta");
    expect((writeOutput.json as { newSnapshotTag?: string }).newSnapshotTag).toMatch(/^[0-9a-f]{12}$/);
    await expect(read.execute({ path: "notes/a.txt" }, context())).resolves.toMatchObject({ text: "alpha\nbeta" });
    await expect(list.execute({ path: "notes" }, context())).resolves.toMatchObject({ text: " a.txt" });
    await expect(search.execute({ query: "beta" }, context())).resolves.toMatchObject({
      json: {
        matches: [{ path: "notes\\a.txt", line: 2, preview: "beta" }]
      }
    });
  });

  it("reads files and directories through the unified read tool", async () => {
    await mkdir(join(workspaceRoot, "notes"), { recursive: true });
    await writeFile(join(workspaceRoot, "notes", "a.txt"), "one\ntwo\nthree", "utf8");
    const read = createReadTool({ workspaceRoot });

    const fileOutput = await read.execute({ path: "notes/a.txt:2-3" }, context());
    expect(fileOutput.text).toContain("snapshotTag:");
    expect(fileOutput.text).toContain("2 | two");
    expect(fileOutput.text).toContain("3 | three");
    expect(fileOutput.json).toMatchObject({
      path: "notes\\a.txt",
      kind: "file",
      selectedStartLine: 2,
      selectedEndLine: 3,
      encoding: "utf-8"
    });
    expect((fileOutput.json as { snapshotTag?: string }).snapshotTag).toMatch(/^[0-9a-f]{12}$/);

    await expect(read.execute({ path: "notes" }, context())).resolves.toMatchObject({
      text: " a.txt",
      json: { kind: "directory" }
    });
  });

  it("records read snapshots with an injected mutation coordinator without acquiring leases", async () => {
    await mkdir(join(workspaceRoot, "notes"), { recursive: true });
    await writeFile(join(workspaceRoot, "notes", "a.txt"), "one\ntwo", "utf8");
    const mutationCoordinator = new WorkspaceMutationCoordinator({ workspaceRoot });
    const read = createReadTool({ workspaceRoot, mutationCoordinator });
    const readFileTool = createReadFileTool({ workspaceRoot, mutationCoordinator });

    const unified = await read.execute({ path: "notes/a.txt" }, context());
    const compatibility = await readFileTool.execute({ path: "notes/a.txt" }, context());
    const unifiedTag = (unified.json as { snapshotTag?: string }).snapshotTag;
    const compatibilityTag = (compatibility.json as { snapshotTag?: string }).snapshotTag;

    expect(unifiedTag).toMatch(/^[0-9a-f]{12}$/);
    expect(compatibilityTag).toBe(unifiedTag);
    expect(mutationCoordinator.latestReadSnapshot("session", "notes/a.txt")).toBe(unifiedTag);
    expect(mutationCoordinator.listLeases()).toEqual([]);
  });

  it("applies numbered line edits through the unified edit tool", async () => {
    await writeFile(join(workspaceRoot, "tracked.txt"), "one\ntwo\nthree\nfour", "utf8");
    const read = createReadTool({ workspaceRoot });
    const edit = createEditTool({ workspaceRoot });
    const readOutput = await read.execute({ path: "tracked.txt" }, context());
    const snapshotTag = (readOutput.json as { snapshotTag: string }).snapshotTag;

    const output = await edit.execute(
      {
        path: "tracked.txt",
        snapshotTag,
        edits: [
          { op: "replace", startLine: 2, endLine: 2, content: "two edited" },
          { op: "insert_after", line: 3, content: "three point five" },
          { op: "delete", line: 1 }
        ]
      },
      context()
    );

    await expect(readFile(join(workspaceRoot, "tracked.txt"), "utf8")).resolves.toBe("two edited\nthree\nthree point five\nfour");
    expect(output.text).toContain("Edited tracked.txt");
    expect(output.text).toContain("Result preview (actual file around changes");
    expect(output.text).toContain("1 | two edited");
    expect(output.text).toContain("3 | three point five");
    expect(output.text).toContain("-two");
    expect(output.text).toContain("+two edited");
    expect((output.json as { newSnapshotTag?: string }).newSnapshotTag).toMatch(/^[0-9a-f]{12}$/);
    expect(output.json).toMatchObject({
      resultPreview: {
        mode: "changed-range",
        truncated: false,
        totalLines: 4
      }
    });
  });

  it("wraps explicit legacy write_file factory in a file mutation lease with owner metadata", async () => {
    const mutationCoordinator = new WorkspaceMutationCoordinator({ workspaceRoot });
    const observedLeases = [] as ReturnType<WorkspaceMutationCoordinator["listLeases"]>;
    const write = createWriteFileTool({
      workspaceRoot,
      mutationCoordinator,
      preMutationCheckpoint: {
        hook: () => {
          observedLeases.push(...mutationCoordinator.listLeases());
          return { status: "skipped", reason: "test" };
        }
      }
    });

    await write.execute({ path: "leased.txt", content: "leased" }, context());

    expect(observedLeases).toHaveLength(1);
    expect(observedLeases[0]).toMatchObject({
      owner: {
        sessionId: "session",
        toolCallId: "call",
        toolName: "write_file",
        cwd: workspaceRoot,
        targetSummary: "leased.txt"
      },
      scope: { type: "files" }
    });
    expect(observedLeases[0]?.scope.type === "files" ? observedLeases[0].scope.paths[0] : "").toContain("leased.txt");
    expect(mutationCoordinator.listLeases()).toEqual([]);
  });

  it("releases file mutation leases when guarded edits throw", async () => {
    await writeFile(join(workspaceRoot, "leased-edit.txt"), "before", "utf8");
    const mutationCoordinator = new WorkspaceMutationCoordinator({ workspaceRoot });
    const edit = createEditTool({
      workspaceRoot,
      mutationCoordinator,
      preMutationCheckpoint: {
        onFailure: "throw",
        hook: () => {
          expect(mutationCoordinator.listLeases()).toHaveLength(1);
          throw new Error("checkpoint hook failed");
        }
      }
    });

    await expect(edit.execute({ path: "leased-edit.txt", content: "after" }, context())).rejects.toThrow("checkpoint hook failed");
    expect(mutationCoordinator.listLeases()).toEqual([]);
    await expect(readFile(join(workspaceRoot, "leased-edit.txt"), "utf8")).resolves.toBe("before");
  });

  it("does not expose removed read formats or edit anchor fields", async () => {
    await writeFile(join(workspaceRoot, "legacy-format.txt"), "one\ntwo\nthree", "utf8");
    const read = createReadTool({ workspaceRoot });
    const edit = createEditTool({ workspaceRoot });
    const removedFormat = "hash" + "line";
    const readSchema = read.inputSchema as { properties: { format?: { enum?: string[] } } };
    const editSchema = edit.inputSchema as { properties: { edits?: { items?: { properties?: Record<string, unknown> } } } };
    const readFormatSchema = readSchema.properties.format ?? {};
    const editItemProperties = editSchema.properties.edits?.items?.properties ?? {};

    expect(readFormatSchema.enum).toEqual(["numbered", "plain"]);
    expect(readFormatSchema.enum).not.toContain(removedFormat);
    expect(editItemProperties).not.toHaveProperty("anchor");
    expect(editItemProperties).not.toHaveProperty("endAnchor");

    const readOutput = await read.execute({ path: "legacy-format.txt", format: removedFormat }, context());
    expect(readOutput.text).toContain("2 | two");
    expect(readOutput.text).not.toMatch(/\b2:[0-9a-f]{4}\b/);
  });

  it("rejects removed edit anchor fields without changing the file", async () => {
    await writeFile(join(workspaceRoot, "removed-anchor.txt"), "one\ntwo\nthree", "utf8");
    const edit = createEditTool({ workspaceRoot });

    await expect(
      edit.execute({ path: "removed-anchor.txt", edits: [{ op: "replace", anchor: "2:abcd", content: "two edited" }] }, context())
    ).rejects.toThrow(/anchor fields are no longer supported/);
    await expect(readFile(join(workspaceRoot, "removed-anchor.txt"), "utf8")).resolves.toBe("one\ntwo\nthree");
  });

  it("returns actual result previews after full file writes", async () => {
    const edit = createEditTool({ workspaceRoot });
    const output = await edit.execute({ path: "created.txt", content: "alpha\nbeta" }, context());
    const outputJson = output.json as {
      newSnapshotTag?: string;
      resultPreview?: { mode?: string; text?: string; truncated?: boolean; totalLines?: number };
    };

    await expect(readFile(join(workspaceRoot, "created.txt"), "utf8")).resolves.toBe("alpha\nbeta");
    expect(output.text).toContain("Result preview (actual file");
    expect(output.text).toContain("1 | alpha");
    expect(output.text).toContain("2 | beta");
    expect(outputJson.newSnapshotTag).toMatch(/^[0-9a-f]{12}$/);
    expect(outputJson.resultPreview).toMatchObject({
      mode: "full",
      truncated: false,
      totalLines: 2
    });
  });

  it("creates and appends files through small edit chunks", async () => {
    const edit = createEditTool({ workspaceRoot });

    const created = await edit.execute(
      {
        path: "chunked.txt",
        edits: [{ op: "insert_tail", content: "alpha\nbeta" }]
      },
      context()
    );
    const appended = await edit.execute(
      {
        path: "chunked.txt",
        edits: [{ op: "insert_tail", content: "gamma" }]
      },
      context()
    );

    await expect(readFile(join(workspaceRoot, "chunked.txt"), "utf8")).resolves.toBe("alpha\nbeta\ngamma");
    expect(created.text).toContain("Edited chunked.txt");
    expect(created.text).toContain("1 | alpha");
    expect(appended.text).toContain("3 | gamma");
    expect((appended.json as { resultPreview?: { text?: string } }).resultPreview?.text).toContain("3 | gamma");
  });

  it("truncates long actual result previews without losing metadata", async () => {
    const edit = createEditTool({ workspaceRoot });
    const content = Array.from({ length: 120 }, (_, index) => `line-${String(index + 1).padStart(3, "0")}`).join("\n");
    const output = await edit.execute({ path: "long.txt", content }, context());
    const preview = (output.json as {
      resultPreview?: { text?: string; truncated?: boolean; omittedLines?: number; totalLines?: number; endLine?: number };
    }).resultPreview;

    expect(preview).toMatchObject({
      truncated: true,
      omittedLines: 40,
      totalLines: 120,
      endLine: 80
    });
    expect(preview?.text).toContain("80 | line-080");
    expect(preview?.text).not.toContain("81 | line-081");
  });

  it("roundtrips Chinese edit result previews from the written file", async () => {
    const edit = createEditTool({ workspaceRoot });
    const content = "\u7f16\u8f91\u540e\n\u6b63\u5e38\u663e\u793a";
    const output = await edit.execute({ path: "cn.txt", content }, context());

    await expect(readFile(join(workspaceRoot, "cn.txt"), "utf8")).resolves.toBe(content);
    expect(output.text).toContain("\u7f16\u8f91\u540e");
    expect(output.text).toContain("\u6b63\u5e38\u663e\u793a");
    expect((output.json as { resultPreview?: { text?: string } }).resultPreview?.text).toContain("\u7f16\u8f91\u540e");
  });

  it("rejects unified edits with stale snapshot tags", async () => {
    await writeFile(join(workspaceRoot, "tracked.txt"), "before", "utf8");
    const read = createReadTool({ workspaceRoot });
    const edit = createEditTool({ workspaceRoot });
    const readOutput = await read.execute({ path: "tracked.txt" }, context());
    const snapshotTag = (readOutput.json as { snapshotTag: string }).snapshotTag;
    await writeFile(join(workspaceRoot, "tracked.txt"), "external change", "utf8");

    await expect(
      edit.execute({ path: "tracked.txt", snapshotTag, content: "after" }, context())
    ).rejects.toThrow(/Stale snapshotTag/);
  });

  it("rejects batch workspace edits with stale coordinator snapshots", async () => {
    await writeFile(join(workspaceRoot, "a.txt"), "alpha", "utf8");
    await writeFile(join(workspaceRoot, "b.txt"), "bravo", "utf8");
    const mutationCoordinator = new WorkspaceMutationCoordinator({ workspaceRoot });
    const read = createReadTool({ workspaceRoot, mutationCoordinator });
    const applyEdits = createApplyWorkspaceEditsTool({ workspaceRoot, mutationCoordinator });

    await read.execute({ path: "a.txt" }, context());
    await writeFile(join(workspaceRoot, "a.txt"), "external", "utf8");

    await expect(
      applyEdits.execute(
        {
          files: [
            { path: "a.txt", content: "alpha edited" },
            { path: "b.txt", edits: [{ op: "replace", line: 1, content: "bravo edited" }] }
          ]
        },
        context()
      )
    ).rejects.toThrow(/Stale snapshotTag/);
    await expect(readFile(join(workspaceRoot, "a.txt"), "utf8")).resolves.toBe("external");
    await expect(readFile(join(workspaceRoot, "b.txt"), "utf8")).resolves.toBe("bravo");
  });

  it("rolls back partial batch workspace edits after an apply-time failure", async () => {
    await writeFile(join(workspaceRoot, "a.txt"), "alpha", "utf8");
    await writeFile(join(workspaceRoot, "b.txt"), "bravo", "utf8");
    let checkpointHookCalled = false;
    const applyEdits = createApplyWorkspaceEditsTool({
      workspaceRoot,
      preMutationCheckpoint: {
        hook: async () => {
          checkpointHookCalled = true;
          await rm(join(workspaceRoot, "b.txt"), { force: true });
          await mkdir(join(workspaceRoot, "b.txt"));
          return { status: "skipped", reason: "test-induced-apply-failure" };
        }
      }
    });

    const output = await applyEdits.execute(
      {
        files: [
          { path: "a.txt", content: "alpha edited" },
          { path: "b.txt", content: "bravo edited" }
        ]
      },
      context()
    );
    const outputJson = output.json as {
      ok?: boolean;
      reason?: string;
      rollback?: { restored?: string[]; deleted?: string[]; failed?: unknown[] };
    };

    expect(checkpointHookCalled).toBe(true);
    expect(outputJson).toMatchObject({
      ok: false,
      reason: "apply-failed",
      rollback: {
        restored: ["a.txt", "b.txt"],
        deleted: [],
        failed: []
      }
    });
    await expect(readFile(join(workspaceRoot, "a.txt"), "utf8")).resolves.toBe("alpha");
    await expect(readFile(join(workspaceRoot, "b.txt"), "utf8")).resolves.toBe("bravo");
  });

  it("adds automatic git checkpoint metadata for batch workspace edits", async () => {
    await initGitRepo();
    const applyEdits = createApplyWorkspaceEditsTool({ workspaceRoot });

    const output = await applyEdits.execute(
      {
        files: [
          { path: "base.txt", content: "base changed" },
          { path: "created.txt", content: "created" }
        ]
      },
      context()
    );
    const outputJson = output.json as {
      ok?: boolean;
      preMutationCheckpoint?: {
        status?: string;
        checkpoint?: { id?: string; refName?: string; toolCall?: { toolName?: string; targetSummary?: string } };
      };
    };
    const checkpoint = outputJson.preMutationCheckpoint?.checkpoint;

    expect(outputJson.ok).toBe(true);
    expect(outputJson.preMutationCheckpoint?.status).toBe("created");
    expect(checkpoint?.id).toBeTruthy();
    expect(checkpoint?.refName).toContain("refs/");
    expect(checkpoint?.toolCall).toMatchObject({
      toolName: "apply_workspace_edits",
      targetSummary: expect.stringContaining("base.txt")
    });

    await new GitCliVersioningService().restoreCheckpoint({
      cwd: workspaceRoot,
      checkpoint: checkpoint!.id!,
      cleanUntracked: true
    });
    await expect(readFile(join(workspaceRoot, "base.txt"), "utf8")).resolves.toBe("base");
    await expect(readFile(join(workspaceRoot, "created.txt"), "utf8")).rejects.toThrow();
  }, 30_000);

  it("wraps batch workspace edits in one multi-file mutation lease", async () => {
    await writeFile(join(workspaceRoot, "a.txt"), "alpha", "utf8");
    await writeFile(join(workspaceRoot, "b.txt"), "bravo", "utf8");
    const mutationCoordinator = new WorkspaceMutationCoordinator({ workspaceRoot });
    const observedLeases = [] as ReturnType<WorkspaceMutationCoordinator["listLeases"]>;
    const applyEdits = createApplyWorkspaceEditsTool({
      workspaceRoot,
      mutationCoordinator,
      preMutationCheckpoint: {
        hook: () => {
          observedLeases.push(...mutationCoordinator.listLeases());
          return { status: "skipped", reason: "test" };
        }
      }
    });

    await applyEdits.execute(
      {
        files: [
          { path: "a.txt", content: "alpha edited" },
          { path: "b.txt", edits: [{ op: "replace", line: 1, content: "bravo edited" }] }
        ]
      },
      context()
    );

    expect(observedLeases).toHaveLength(1);
    expect(observedLeases[0]).toMatchObject({
      owner: {
        sessionId: "session",
        toolCallId: "call",
        toolName: "apply_workspace_edits",
        cwd: workspaceRoot,
        targetSummary: expect.stringContaining("2 files")
      },
      scope: { type: "files" }
    });
    const leasePaths = observedLeases[0]?.scope.type === "files" ? observedLeases[0].scope.paths.join("\n") : "";
    expect(leasePaths).toContain("a.txt");
    expect(leasePaths).toContain("b.txt");
    expect(mutationCoordinator.listLeases()).toEqual([]);
  });

  it("preserves existing utf-16 file encoding when editing text", async () => {
    const filePath = join(workspaceRoot, "utf16-edit.txt");
    await writeFile(filePath, encodeTextBuffer("before\nline", "utf-16le"));
    const edit = createEditTool({ workspaceRoot });
    const read = createReadFileTool({ workspaceRoot });

    const output = await edit.execute(
      {
        path: "utf16-edit.txt",
        edits: [{ op: "replace", line: 1, content: "after" }]
      },
      context()
    );
    const raw = await readFile(filePath);

    expect(output.json).toMatchObject({ encoding: "utf-16le" });
    expect(raw.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    await expect(read.execute({ path: "utf16-edit.txt" }, context())).resolves.toMatchObject({
      text: "after\nline",
      json: { encoding: "utf-16le" }
    });
  });

  it("rejects out-of-range line edits instead of silently clamping", async () => {
    await writeFile(join(workspaceRoot, "short.txt"), "one\ntwo\nthree\nfour\nfive\nsix", "utf8");
    const edit = createEditTool({ workspaceRoot });
    const before = await readFile(join(workspaceRoot, "short.txt"), "utf8");

    await expect(
      edit.execute(
        {
          path: "short.txt",
          edits: [{ op: "delete", startLine: 99, endLine: 100 }]
        },
        context()
      )
    ).rejects.toThrow(/out of range/);
    await expect(readFile(join(workspaceRoot, "short.txt"), "utf8")).resolves.toBe(before);

    await expect(
      edit.execute(
        {
          path: "short.txt",
          edits: [{ op: "replace", startLine: 10, content: "nope" }]
        },
        context()
      )
    ).rejects.toThrow(/out of range \(file has 6 lines\)/);
  });

  it("mentions created parent directories for new nested files and refuses silent mkdir for missing parents of existing files", async () => {
    const edit = createEditTool({ workspaceRoot });
    const created = await edit.execute(
      {
        path: "nested/deep/new.txt",
        content: "hello"
      },
      context()
    );

    await expect(readFile(join(workspaceRoot, "nested", "deep", "new.txt"), "utf8")).resolves.toBe("hello");
    expect(created.text).toMatch(/Created parent directories/i);
    expect(created.json).toMatchObject({ createdParentDirectories: true });

    await writeFile(join(workspaceRoot, "existing.txt"), "keep", "utf8");
    // Simulate a pathological case: target path under a non-directory parent name is blocked earlier;
    // for a brand-new nested path with only line edits that require an existing file, still error clearly.
    await expect(
      edit.execute(
        {
          path: "ghost/dir/missing.txt",
          edits: [{ op: "replace", line: 1, content: "x" }]
        },
        context()
      )
    ).rejects.toThrow(/Cannot apply line edits to a missing file/);
  });

  it("unifies search_files empty and hit output formats", async () => {
    await mkdir(join(workspaceRoot, "notes"), { recursive: true });
    await writeFile(join(workspaceRoot, "notes", "a.txt"), "alpha\nbeta", "utf8");
    const search = createSearchFilesTool({ workspaceRoot });

    const hits = await search.execute({ query: "beta" }, context());
    expect(hits.text).toContain("query: beta");
    expect(hits.text).toContain("matches: 1");
    expect(hits.text).toContain("visitedFiles:");
    expect(hits.text).toContain("---");
    expect(hits.text).toMatch(/a\.txt:2: beta/);
    expect(hits.json).toMatchObject({
      query: "beta",
      matchCount: 1,
      truncated: false,
      matches: [{ line: 2, preview: "beta" }]
    });

    const empty = await search.execute({ query: "zzz-no-match" }, context());
    expect(empty.text).toContain("query: zzz-no-match");
    expect(empty.text).toContain("matches: 0");
    expect(empty.text).toContain("---");
    expect(empty.text).toContain("(no matches)");
    expect(empty.json).toMatchObject({
      query: "zzz-no-match",
      matchCount: 0,
      truncated: false,
      matches: []
    });
  });

  it("enforces read maxBytes truncation with totals in text and json", async () => {
    const content = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join("\n");
    await writeFile(join(workspaceRoot, "big.txt"), content, "utf8");
    const read = createReadTool({ workspaceRoot });

    const output = await read.execute({ path: "big.txt", maxBytes: 50, format: "plain" }, context());
    expect(output.text).toMatch(/truncated: true \(showing \d+ of \d+ chars/);
    expect(output.text).toContain("file has");
    expect(output.text).toContain("... truncated ...");
    expect(output.json).toMatchObject({
      truncated: true,
      totalChars: content.length,
      shownChars: 50
    });
    expect((output.json as { selectedChars?: number }).selectedChars).toBeGreaterThan(50);
  });

  it("avoids extra blank lines when insert_tail follows a trailing newline", async () => {
    await writeFile(join(workspaceRoot, "tail.txt"), "alpha\nbeta\n", "utf8");
    const edit = createEditTool({ workspaceRoot });

    await edit.execute(
      {
        path: "tail.txt",
        edits: [{ op: "insert_tail", content: "gamma" }]
      },
      context()
    );
    await expect(readFile(join(workspaceRoot, "tail.txt"), "utf8")).resolves.toBe("alpha\nbeta\ngamma\n");

    await edit.execute(
      {
        path: "tail.txt",
        edits: [{ op: "insert_tail", content: "delta\n" }]
      },
      context()
    );
    await expect(readFile(join(workspaceRoot, "tail.txt"), "utf8")).resolves.toBe("alpha\nbeta\ngamma\ndelta\n");
  });

  it("returns friendly ENOENT errors for read and list_directory", async () => {
    const read = createReadTool({ workspaceRoot });
    const list = createListDirectoryTool({ workspaceRoot });

    await expect(read.execute({ path: "missing-file.txt" }, context())).rejects.toThrow(
      /Path does not exist: missing-file\.txt/
    );
    await expect(list.execute({ path: "missing-dir" }, context())).rejects.toThrow(
      /Path does not exist: missing-dir|Directory does not exist: missing-dir/
    );
  });

  it("lists directories and files with consistent prefixes", async () => {
    await mkdir(join(workspaceRoot, "tree", "subdir"), { recursive: true });
    await writeFile(join(workspaceRoot, "tree", "a.txt"), "a", "utf8");
    const list = createListDirectoryTool({ workspaceRoot });
    const read = createReadTool({ workspaceRoot });

    const listed = await list.execute({ path: "tree" }, context());
    expect(listed.text?.split("\n")).toEqual(expect.arrayContaining(["/subdir", " a.txt"]));
    expect(listed.text).toMatch(/^\/subdir$/m);
    expect(listed.text).toMatch(/^ a\.txt$/m);

    const viaRead = await read.execute({ path: "tree" }, context());
    expect(viaRead.text?.split("\n")).toEqual(expect.arrayContaining(["/subdir", " a.txt"]));
  });

  it("registers only unified product file tools by default", () => {
    const names = createLocalWorkspaceTools({ workspaceRoot }).map((tool) => tool.name);

    expect(names).toContain("shell_command");
    expect(names).toContain("read");
    expect(names).toContain("edit");
    expect(names).toContain("apply_workspace_edits");
    expect(names).toContain("list_directory");
    expect(names).toContain("search_files");
    expect(names).toContain("restore_file_snapshot");
    expect(names).toContain("create_workspace_checkpoint");
    expect(names).toContain("restore_workspace_checkpoint");
    expect(names).not.toContain("read_file");
    expect(names).not.toContain("write_file");
  });

  it("keeps read_file and write_file available as explicit legacy factories", () => {
    const read = createReadFileTool({ workspaceRoot });
    const write = createWriteFileTool({ workspaceRoot });

    expect(read.name).toBe("read_file");
    expect(read.description).toContain("Explicit legacy read_file factory");
    expect(write.name).toBe("write_file");
    expect(write.description).toContain("Explicit legacy write_file factory");
  });

  it("rejects paths outside the workspace through the explicit legacy read_file factory", async () => {
    const read = createReadFileTool({ workspaceRoot });
    await writeFile(join(workspaceRoot, "safe.txt"), "safe", "utf8");

    await expect(read.execute({ path: "../outside.txt" }, context())).rejects.toThrow(/escapes workspace/);
  });

  it("snapshots overwritten files and can restore them", async () => {
    await writeFile(join(workspaceRoot, "tracked.txt"), "before", "utf8");
    const write = createWriteFileTool({ workspaceRoot });
    const restore = createRestoreFileSnapshotTool({ workspaceRoot });

    const output = await write.execute({ path: "tracked.txt", content: "after" }, context());
    const snapshotPath = output.artifacts?.[0]?.uri;

    expect(snapshotPath).toBeTruthy();
    await expect(readFile(join(workspaceRoot, "tracked.txt"), "utf8")).resolves.toBe("after");

    await restore.execute({ snapshotPath: snapshotPath!, targetPath: "tracked.txt" }, context());
    await expect(readFile(join(workspaceRoot, "tracked.txt"), "utf8")).resolves.toBe("before");
  });

  it("creates workspace checkpoints through local tools", async () => {
    await writeFile(join(workspaceRoot, "tracked.txt"), "before", "utf8");
    const checkpoint = createWorkspaceCheckpointTool({ workspaceRoot });
    const restore = createRestoreWorkspaceCheckpointTool({ workspaceRoot });

    const output = await checkpoint.execute({ label: "before changes", files: ["tracked.txt", "new.txt"] }, context());
    const outputJson = output.json as { manifestPath?: string };
    const checkpointPath = outputJson.manifestPath ?? "";

    await writeFile(join(workspaceRoot, "tracked.txt"), "after", "utf8");
    await writeFile(join(workspaceRoot, "new.txt"), "created", "utf8");
    await restore.execute({ checkpointPath }, context());

    await expect(readFile(join(workspaceRoot, "tracked.txt"), "utf8")).resolves.toBe("before");
    await expect(readFile(join(workspaceRoot, "new.txt"), "utf8")).rejects.toThrow();
  });

  it("uses a workspace mutation lease for workspace checkpoint restore and releases aborted waiters", async () => {
    await writeFile(join(workspaceRoot, "tracked.txt"), "before", "utf8");
    const checkpoint = createWorkspaceCheckpointTool({ workspaceRoot });
    const mutationCoordinator = new WorkspaceMutationCoordinator({ workspaceRoot });
    const restore = createRestoreWorkspaceCheckpointTool({ workspaceRoot, mutationCoordinator });
    const checkpointOutput = await checkpoint.execute({ label: "before changes", files: ["tracked.txt"] }, context());
    const checkpointPath = (checkpointOutput.json as { manifestPath?: string }).manifestPath ?? "";
    await writeFile(join(workspaceRoot, "tracked.txt"), "after", "utf8");
    const activeFileLease = await mutationCoordinator.acquire({ scope: { type: "files", paths: ["tracked.txt"] } });
    expect(activeFileLease.ok).toBe(true);
    const abortController = new AbortController();

    const restoring = restore.execute({ checkpointPath }, context({ signal: abortController.signal }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();

    await expect(restoring).rejects.toThrow(/aborted/);
    expect(mutationCoordinator.listLeases()).toHaveLength(1);
    if (activeFileLease.ok) mutationCoordinator.release(activeFileLease.lease.token);
    expect(mutationCoordinator.listLeases()).toEqual([]);
    await expect(readFile(join(workspaceRoot, "tracked.txt"), "utf8")).resolves.toBe("after");
  });

  it("adds an automatic git checkpoint when explicit legacy write_file creates a new file in a repo", async () => {
    await initGitRepo();
    const write = createWriteFileTool({ workspaceRoot });

    const output = await write.execute({ path: "created.txt", content: "new" }, context());
    const outputJson = output.json as {
      preMutationCheckpoint?: {
        status?: string;
        checkpoint?: { id?: string; refName?: string };
      };
    };
    const checkpoint = outputJson.preMutationCheckpoint?.checkpoint;
    expect(outputJson.preMutationCheckpoint?.status).toBe("created");
    expect(checkpoint?.id).toBeTruthy();
    expect(checkpoint?.refName).toContain("refs/");

    await new GitCliVersioningService().restoreCheckpoint({
      cwd: workspaceRoot,
      checkpoint: checkpoint!.id!,
      cleanUntracked: true
    });
    await expect(readFile(join(workspaceRoot, "created.txt"), "utf8")).rejects.toThrow();
  }, 30_000);

  it("preserves existing utf-16 file encoding when writing text", async () => {
    const filePath = join(workspaceRoot, "utf16.txt");
    await writeFile(filePath, encodeTextBuffer("before", "utf-16le"));
    const write = createWriteFileTool({ workspaceRoot });
    const read = createReadFileTool({ workspaceRoot });

    const output = await write.execute({ path: "utf16.txt", content: "after" }, context());
    const raw = await readFile(filePath);

    expect(output.json).toMatchObject({ encoding: "utf-16le" });
    expect(raw.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    await expect(read.execute({ path: "utf16.txt" }, context())).resolves.toMatchObject({
      text: "after",
      json: { encoding: "utf-16le" }
    });
  });
});
