import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEditTool,
  createListDirectoryTool,
  createLocalWorkspaceTools,
  createReadTool,
  createReadFileTool,
  createRestoreFileSnapshotTool,
  createRestoreWorkspaceCheckpointTool,
  createSearchFilesTool,
  createTerminalCommandTool,
  createWorkspaceCheckpointTool,
  createWriteFileTool
} from ".";
import { encodeTextBuffer } from "./encoding";
import type { ToolExecutionContext } from "./types";

let workspaceRoot = "";

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "agent-runtime-"));
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

async function waitForBackgroundTaskState(tool: ReturnType<typeof createTerminalCommandTool>, taskId: string, state: string): Promise<{ state?: string }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const output = await tool.execute({ backgroundAction: "get", taskId }, context());
    const json = output.json as { state?: string };
    if (json.state === state) return json;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for background command ${taskId} to reach ${state}`);
}

describe("local workspace tools", () => {
  it("runs terminal commands and returns structured output", async () => {
    const tool = createTerminalCommandTool({ workspaceRoot, defaultTimeoutMs: 10_000 });
    const output = await tool.execute({ command: 'node -e "console.log(123)"' }, context());

    expect(output.text).toContain("Exit code: 0");
    expect(output.text).toContain("123");
    expect(output.json).toMatchObject({ exitCode: 0 });
  });

  it("propagates native command exit codes through the shell wrapper", async () => {
    const tool = createTerminalCommandTool({ workspaceRoot, defaultTimeoutMs: 10_000 });
    const output = await tool.execute({ command: 'node -e "process.exit(7)"' }, context());

    expect(output.text).toContain("Exit code: 7");
    expect(output.json).toMatchObject({ exitCode: 7 });
  });

  it("runs common chained commands through the default shell wrapper", async () => {
    const tool = createTerminalCommandTool({ workspaceRoot, defaultTimeoutMs: 10_000 });
    const output = await tool.execute(
      { command: 'node -e "process.stdout.write(\'first\')" && node -e "process.stdout.write(\'second\')"' },
      context()
    );

    expect(output.text).toContain("Exit code: 0");
    expect(output.text).toContain("firstsecond");
    expect(output.json).toMatchObject({ exitCode: 0 });
  });

  it("preserves Chinese terminal output through the shell wrapper", async () => {
    const tool = createTerminalCommandTool({ workspaceRoot, defaultTimeoutMs: 10_000 });
    const output = await tool.execute({ command: 'node -e "console.log(\'中文探针\')"' }, context());

    expect(output.text).toContain("Exit code: 0");
    expect(output.text).toContain("中文探针");
    expect(output.json).toMatchObject({ stdout: "中文探针\n" });
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

  it("runs background command lifecycle through shell_command", async () => {
    await writeFile(join(workspaceRoot, "bg-tool.js"), "setTimeout(() => console.log('done'), 30000);", "utf8");
    const tool = createTerminalCommandTool({
      workspaceRoot,
      defaultTimeoutMs: 10_000,
      backgroundDefaultTimeoutMs: 10_000
    });

    const started = await tool.execute({ command: "node bg-tool.js", background: true }, context());
    const taskId = (started.json as { id: string }).id;
    const listed = await tool.execute({ backgroundAction: "list" }, context());
    const status = await tool.execute({ backgroundAction: "get", taskId }, context());
    const cancel = await tool.execute({ backgroundAction: "cancel", taskId }, context());
    const cancelled = await waitForBackgroundTaskState(tool, taskId, "cancelled");

    expect(started.text).toContain("Background command started");
    expect(taskId).toMatch(/^bgcmd-/);
    expect(listed.text).toContain(taskId);
    expect(status.text).toContain(taskId);
    expect(cancel.text).toContain("Background command cancellation requested");
    expect(cancelled).toMatchObject({ state: "cancelled" });
  }, 15_000);

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

  it("applies line-anchored edits through the unified edit tool", async () => {
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

  it("applies hashline-anchored edits from read output", async () => {
    await writeFile(join(workspaceRoot, "hashline.txt"), "one\ntwo\nthree", "utf8");
    const read = createReadTool({ workspaceRoot });
    const edit = createEditTool({ workspaceRoot });
    const readOutput = await read.execute({ path: "hashline.txt", format: "hashline" }, context());
    const anchor = readOutput.text?.match(/\b2:[0-9a-f]{4}\b/)?.[0];

    expect(anchor).toBeTruthy();
    expect(readOutput.text).toContain(`${anchor} | two`);
    const lineAnchor = anchor!;

    const output = await edit.execute(
      {
        path: "hashline.txt",
        edits: [{ op: "replace", anchor: lineAnchor, content: "two edited" }]
      },
      context()
    );

    await expect(readFile(join(workspaceRoot, "hashline.txt"), "utf8")).resolves.toBe("one\ntwo edited\nthree");
    expect(output.text).toContain("2 | two edited");
    expect((output.json as { resultPreview?: { text?: string } }).resultPreview?.text).toContain("2 | two edited");
  });

  it("rejects stale hashline anchors with nearby current anchors", async () => {
    await writeFile(join(workspaceRoot, "stale-anchor.txt"), "one\ntwo\nthree", "utf8");
    const read = createReadTool({ workspaceRoot });
    const edit = createEditTool({ workspaceRoot });
    const readOutput = await read.execute({ path: "stale-anchor.txt", format: "hashline" }, context());
    const anchor = readOutput.text?.match(/\b2:[0-9a-f]{4}\b/)?.[0];
    expect(anchor).toBeTruthy();
    const lineAnchor = anchor!;

    await writeFile(join(workspaceRoot, "stale-anchor.txt"), "one\ntwo changed\nthree", "utf8");

    await expect(
      edit.execute({ path: "stale-anchor.txt", edits: [{ op: "replace", anchor: lineAnchor, content: "two edited" }] }, context())
    ).rejects.toThrow(/Stale line anchor/);
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

  it("registers unified read and edit tools alongside compatibility tools", () => {
    const names = createLocalWorkspaceTools({ workspaceRoot }).map((tool) => tool.name);

    expect(names).toContain("read");
    expect(names).toContain("edit");
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
  });

  it("rejects paths outside the workspace", async () => {
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

  it("adds an automatic checkpoint when write_file creates a new file", async () => {
    const write = createWriteFileTool({ workspaceRoot });
    const restore = createRestoreWorkspaceCheckpointTool({ workspaceRoot });

    const output = await write.execute({ path: "created.txt", content: "new" }, context());
    const outputJson = output.json as { checkpoint?: { manifestPath?: string } | null };
    const checkpoint = outputJson.checkpoint;
    const checkpointPath = checkpoint?.manifestPath ?? "";
    expect(checkpointPath).toContain("checkpoint.json");

    await restore.execute({ checkpointPath }, context());
    await expect(readFile(join(workspaceRoot, "created.txt"), "utf8")).rejects.toThrow();
  });

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
