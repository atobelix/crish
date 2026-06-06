import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackgroundCommandManager, createBackgroundCommandTools } from "./background-command";
import type { ToolExecutionContext } from "./types";

let workspaceRoot = "";

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "agent-runtime-bg-"));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function context(): ToolExecutionContext {
  return {
    toolCallId: "call",
    sessionId: "session",
    cwd: workspaceRoot,
    signal: new AbortController().signal,
    emit: () => undefined
  };
}

describe("background command manager", () => {
  it("starts a real command, tracks output, and resolves when it finishes", async () => {
    await writeFile(join(workspaceRoot, "bg-test.js"), 'setTimeout(() => console.log("后台中文完成"), 30);', "utf8");
    const events: string[] = [];
    const manager = new BackgroundCommandManager({
      workspaceRoot,
      defaultTimeoutMs: 5_000,
      maxOutputBytes: 20_000
    });
    manager.subscribe((event) => events.push(event.type));

    const started = await manager.start({ command: "node bg-test.js" });
    const finished = await manager.waitForTask(started.id, 5_000);

    expect(started.state).toBe("running");
    expect(finished).toMatchObject({
      id: started.id,
      state: "succeeded",
      exitCode: 0
    });
    expect(finished.outputPreview).toContain("后台中文完成");
    expect(events).toContain("task-start");
    expect(events).toContain("task-output");
    expect(events).toContain("task-end");
  });

  it("propagates native command exit codes through the shell wrapper", async () => {
    const manager = new BackgroundCommandManager({
      workspaceRoot,
      defaultTimeoutMs: 5_000
    });

    const started = await manager.start({ command: 'node -e "process.exit(7)"' });
    const finished = await manager.waitForTask(started.id, 5_000);

    expect(finished).toMatchObject({
      id: started.id,
      state: "failed",
      exitCode: 7
    });
  });

  it("emits heartbeat events for silent long-running commands", async () => {
    const events: string[] = [];
    const manager = new BackgroundCommandManager({
      workspaceRoot,
      defaultTimeoutMs: 5_000,
      heartbeatIntervalMs: 1_000
    });
    manager.subscribe((event) => events.push(event.type));

    const started = await manager.start({
      command: "node -e \"setTimeout(() => {}, 1200)\""
    });
    const finished = await manager.waitForTask(started.id, 5_000);

    expect(finished.state).toBe("succeeded");
    expect(events).toContain("task-heartbeat");
    expect(events.at(-1)).toBe("task-end");
  });

  it("exposes start, get, list, and cancel tools", async () => {
    await writeFile(join(workspaceRoot, "bg-tool.js"), "setTimeout(() => console.log('done'), 30000);", "utf8");
    const manager = new BackgroundCommandManager({
      workspaceRoot,
      defaultTimeoutMs: 5_000
    });
    const tools = createBackgroundCommandTools(manager);
    const start = tools.find((tool) => tool.name === "start_background_command")!;
    const get = tools.find((tool) => tool.name === "get_background_command")!;
    const list = tools.find((tool) => tool.name === "list_background_commands")!;
    const cancel = tools.find((tool) => tool.name === "cancel_background_command")!;

    const startOutput = await start.execute({ command: "node bg-tool.js" }, context());
    const taskId = (startOutput.json as { id: string }).id;
    const getOutput = await get.execute({ taskId }, context());
    const listOutput = await list.execute({}, context());
    const cancelOutput = await cancel.execute({ taskId }, context());
    const cancelled = await manager.waitForTask(taskId, 5_000);

    expect(getOutput.text).toContain(taskId);
    expect(listOutput.text).toContain(taskId);
    expect(cancelOutput.text).toContain(taskId);
    expect(cancelled.state).toBe("cancelled");
  }, 15_000);

  it("blocks hardline commands below the approval layer", async () => {
    const manager = new BackgroundCommandManager({ workspaceRoot });

    await expect(manager.start({ command: "shutdown /s" })).rejects.toThrow(/hardline|shutdown|reboot/i);
  });
});
