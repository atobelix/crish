import { describe, expect, it } from "vitest";
import { InMemoryContextState } from "./context-state";
import type { ContextCompressionRecord } from "./types";

function compressionRecord(id: string, summary: string): ContextCompressionRecord {
  return {
    id,
    trigger: "auto",
    summary,
    compressedMessageIds: [],
    keptMessageIds: [],
    tokensBefore: 100,
    tokensAfter: 20,
    createdAt: new Date(0).toISOString()
  };
}

describe("context state", () => {
  it("keeps task summaries, pending tasks, recent session events, and file hints for compression", () => {
    const state = new InMemoryContextState();
    state.addTask("wire compression", "task_a");
    state.completeTask("task_a", "runtime emits compression events");
    state.addTask("add checkpoints", "task_b");
    state.recordEvent("event before first compaction");
    state.recordCompression(compressionRecord("compact_a", "summary a"));
    state.recordEvent("event after first compaction");
    state.recordCompression(compressionRecord("compact_b", "summary b"));
    state.recordEvent("event after second compaction");
    state.markFileSnapshot("src/runtime.ts", "compression integration", "snap_a");

    const snapshot = state.snapshotForCompression();

    expect(snapshot.completedTaskSummaries).toEqual(["wire compression: runtime emits compression events"]);
    expect(snapshot.pendingTasks).toEqual(["task_b: add checkpoints"]);
    expect(snapshot.sessionEvents.join("\n")).not.toContain("event before first compaction");
    expect(snapshot.sessionEvents.join("\n")).toContain("event after first compaction");
    expect(snapshot.sessionEvents.join("\n")).toContain("event after second compaction");
    expect(snapshot.fileSnapshotHints).toEqual(["src/runtime.ts: compression integration (snap_a)"]);
    expect(snapshot.previousCompressionSummary).toBe("summary b");
  });

  it("records checkpoint files as compression file hints", () => {
    const state = new InMemoryContextState();

    state.recordCheckpoint({
      id: "cp_1",
      kind: "workspace-checkpoint",
      label: "before edit",
      toolCallId: "call_1",
      toolName: "edit",
      metadata: {
        filePaths: ["src/a.ts", "src/b.ts"]
      }
    });
    state.recordCheckpoint({
      id: "snap_1",
      kind: "file-snapshot",
      label: "Snapshot: src/c.ts",
      toolCallId: "call_2",
      toolName: "write_file",
      sourcePath: "src/c.ts",
      snapshotPath: "snapshot/c.ts"
    });

    const snapshot = state.snapshotForCompression();

    expect(snapshot.fileSnapshotHints).toEqual([
      "src/a.ts: checkpoint: before edit (cp_1)",
      "src/b.ts: checkpoint: before edit (cp_1)",
      "src/c.ts: snapshot: Snapshot: src/c.ts (snap_1)"
    ]);
  });
});
