import { describe, expect, it } from "vitest";
import { SessionTree, type SessionTreeEntry } from "./session-tree";
import type { OrchestratorSessionRecord } from "./types";

describe("SessionTree", () => {
  it("appends nodes as children of the current leaf and advances the leaf pointer", () => {
    const tree = testTree();

    const first = tree.appendNode({ payload: { text: "first" } });
    const second = tree.appendNode({ payload: { text: "second" } });

    expect(first.parentId).toBeNull();
    expect(second.parentId).toBe(first.id);
    expect(tree.getCurrentLeafId()).toBe(second.id);
    expect(tree.readBranchPath().map((entry) => entry.id)).toEqual([first.id, second.id]);
  });

  it("forks a branch without rewriting the original path", () => {
    const tree = testTree();
    const root = tree.appendNode({ payload: { text: "root" } });
    const originalLeaf = tree.appendNode({ payload: { text: "original" } });

    const branchLeaf = tree.forkBranch(root.id, { payload: { text: "branch" } });

    expect(branchLeaf.parentId).toBe(root.id);
    expect(tree.getCurrentLeafId()).toBe(branchLeaf.id);
    expect(tree.getEntry(originalLeaf.id)).toEqual(originalLeaf);
    expect(tree.readBranchPath(originalLeaf.id).map((entry) => entry.id)).toEqual([root.id, originalLeaf.id]);
    expect(tree.readBranchPath(branchLeaf.id).map((entry) => entry.id)).toEqual([root.id, branchLeaf.id]);
  });

  it("moves the leaf pointer without appending entries", () => {
    const tree = testTree();
    const root = tree.appendNode({ payload: { text: "root" } });
    const oldLeaf = tree.appendNode({ payload: { text: "old" } });
    const countBeforeMove = tree.getEntries().length;

    tree.moveLeaf(root.id);
    const newLeaf = tree.appendNode({ payload: { text: "new" } });

    expect(tree.getEntries()).toHaveLength(countBeforeMove + 1);
    expect(newLeaf.parentId).toBe(root.id);
    expect(tree.readBranchPath(oldLeaf.id).map((entry) => entry.id)).toEqual([root.id, oldLeaf.id]);
  });

  it("abandons the active branch by attaching a summary at the restored target", () => {
    const tree = testTree();
    const root = tree.appendNode({ payload: { text: "root" } });
    const abandonedLeaf = tree.appendNode({ payload: { text: "abandoned work" } });

    const summary = tree.abandonBranchWithSummary(root.id, {
      summary: "Captured the abandoned work.",
      details: { reason: "changed direction" }
    });

    expect(summary.type).toBe("branch_summary");
    expect(summary.parentId).toBe(root.id);
    expect(summary.abandonedLeafId).toBe(abandonedLeaf.id);
    expect(tree.getCurrentLeafId()).toBe(summary.id);
    expect(tree.readBranchPath().map((entry) => entry.id)).toEqual([root.id, summary.id]);
    expect(tree.readBranchPath(abandonedLeaf.id).map((entry) => entry.id)).toEqual([root.id, abandonedLeaf.id]);
  });

  it("restores the leaf from an orchestrator session record and can write it back", () => {
    const tree = testTree();
    const root = tree.appendNode({ payload: { text: "root" } });
    const leaf = tree.appendNode({ payload: { text: "leaf" } });
    const session: OrchestratorSessionRecord = {
      id: "session_test",
      cwd: "C:/repo",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      status: "open",
      currentLeafId: root.id
    };

    tree.restoreLeaf(session);
    expect(tree.getCurrentLeafId()).toBe(root.id);

    tree.moveLeaf(leaf.id);
    tree.applyLeafToSession(session);
    expect(session.currentLeafId).toBe(leaf.id);
  });

  it("restores to the last appended entry when no currentLeafId is stored", () => {
    const entries: SessionTreeEntry[] = [
      {
        type: "node",
        id: "entry_1",
        parentId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: { text: "first" }
      },
      {
        type: "node",
        id: "entry_2",
        parentId: "entry_1",
        createdAt: "2026-01-01T00:00:01.000Z",
        payload: { text: "second" }
      }
    ];

    const tree = new SessionTree({ entries });

    expect(tree.getCurrentLeafId()).toBe("entry_2");
    expect(tree.snapshot()).toMatchObject({ currentLeafId: "entry_2" });
  });

  it("allows restoring to the root-before-first-entry position", () => {
    const tree = testTree();
    tree.appendNode({ payload: { text: "old root" } });

    tree.restoreLeaf(null);
    const newRoot = tree.appendNode({ payload: { text: "new root" } });

    expect(newRoot.parentId).toBeNull();
    expect(tree.readBranchPath(newRoot.id).map((entry) => entry.id)).toEqual([newRoot.id]);
  });

  it("rejects invalid history references", () => {
    expect(() =>
      new SessionTree({
        entries: [
          {
            type: "node",
            id: "child",
            parentId: "missing",
            createdAt: "2026-01-01T00:00:00.000Z",
            payload: { text: "child" }
          }
        ]
      })
    ).toThrow(/must appear before the child/);

    const tree = testTree();
    tree.appendNode({ payload: { text: "root" } });
    expect(() => tree.moveLeaf("missing")).toThrow(/not found/);
    expect(() => tree.readBranchPath("missing")).toThrow(/not found/);
  });
});

function testTree(): SessionTree {
  let sequence = 0;
  return new SessionTree({
    now: () => `2026-01-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    createId: (prefix) => `${prefix}_${++sequence}`
  });
}
