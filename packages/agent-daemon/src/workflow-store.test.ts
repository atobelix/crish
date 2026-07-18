import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileWorkflowStore,
  WorkflowStoreWriteError,
  WORKFLOW_STORE_VERSION,
} from "./workflow-store";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("FileWorkflowStore", () => {
  it("persists workflows and runs through atomic rewrite with file fsync enabled", async () => {
    const filePath = await tempStorePath();
    const store = new FileWorkflowStore(filePath);

    const workflow = await store.createWorkflow(
      {
        id: "wf_persist",
        name: "Persistent workflow",
        prompt: "Run the daily check",
        cwd: "C:/workspace/crish",
        schedule: { type: "daily", time: "09:00", timezone: "Asia/Shanghai" },
      },
      new Date("2026-06-08T00:00:00.000Z")
    );
    await store.appendRun({
      workflowId: workflow.id,
      runId: "run_persist",
      sessionId: "session_persist",
      scheduledFor: "2026-06-08T01:00:00.000Z",
      startedAt: "2026-06-08T01:00:01.000Z",
      status: "running",
    });

    const restored = new FileWorkflowStore(filePath);
    await expect(restored.listWorkflows()).resolves.toMatchObject([{ id: "wf_persist" }]);
    await expect(restored.listRuns("wf_persist")).resolves.toMatchObject([{ runId: "run_persist" }]);

    const persisted = JSON.parse(await readFile(filePath, "utf8")) as { version: number };
    expect(persisted.version).toBe(WORKFLOW_STORE_VERSION);
  });

  it("surfaces strict directory fsync failure instead of reporting a fake durable write", async () => {
    const filePath = await tempStorePath();
    const store = new FileWorkflowStore(filePath, { fsyncDirectory: true });

    if (process.platform !== "win32") {
      return;
    }

    await expect(
      store.createWorkflow({
        id: "wf_strict_dirsync",
        name: "Strict dirsync",
        prompt: "Run check",
        cwd: "C:/workspace/crish",
        schedule: { type: "manual" },
      })
    ).rejects.toBeInstanceOf(WorkflowStoreWriteError);
  });
});

async function tempStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "daemon-workflow-store-"));
  tempDirs.push(dir);
  return join(dir, "workflows.json");
}
