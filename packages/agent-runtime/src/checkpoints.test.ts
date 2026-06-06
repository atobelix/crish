import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceCheckpoint, restoreWorkspaceCheckpoint } from "./checkpoints";

let workspaceRoot = "";

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "agent-runtime-checkpoint-"));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe("workspace checkpoints", () => {
  it("restores modified files and deletes files created after a checkpoint", async () => {
    await writeFile(join(workspaceRoot, "existing.txt"), "before", "utf8");

    const checkpoint = await createWorkspaceCheckpoint({
      workspaceRoot,
      sessionId: "session",
      label: "before edit",
      files: ["existing.txt", "created.txt"]
    });

    await writeFile(join(workspaceRoot, "existing.txt"), "after", "utf8");
    await writeFile(join(workspaceRoot, "created.txt"), "new", "utf8");

    const result = await restoreWorkspaceCheckpoint({
      workspaceRoot,
      checkpointPath: checkpoint.manifestPath
    });

    await expect(readFile(join(workspaceRoot, "existing.txt"), "utf8")).resolves.toBe("before");
    await expect(readFile(join(workspaceRoot, "created.txt"), "utf8")).rejects.toThrow();
    expect(result.restored).toEqual(["existing.txt"]);
    expect(result.deleted).toEqual(["created.txt"]);
  });

  it("rejects checkpoint paths that escape the workspace", async () => {
    await expect(
      createWorkspaceCheckpoint({
        workspaceRoot,
        sessionId: "session",
        label: "escape",
        files: ["../outside.txt"]
      })
    ).rejects.toThrow(/escapes allowed root/);
  });
});
