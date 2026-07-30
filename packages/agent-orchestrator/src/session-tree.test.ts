import { describe, expect, it } from "vitest";
import { CrishError } from "@crish/shared-types";
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
    // R6: loadEntries invalid_state (parent must appear before child)
    const parentError = captureThrow(() =>
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
    );
    expect(parentError).toBeInstanceOf(CrishError);
    expect((parentError as CrishError).code).toBe("session.invalid_state");
    expect((parentError as CrishError).category).toBe("permanent");
    expect((parentError as CrishError).retryable).toBe(false);

    // R6: assertValidLeafTarget not_found (moveLeaf missing)
    const tree = testTree();
    tree.appendNode({ payload: { text: "root" } });

    const moveError = captureThrow(() => tree.moveLeaf("missing"));
    expect(moveError).toBeInstanceOf(CrishError);
    expect((moveError as CrishError).code).toBe("session.not_found");

    // R6: readBranchPath not_found (entry missing)
    const readError = captureThrow(() => tree.readBranchPath("missing"));
    expect(readError).toBeInstanceOf(CrishError);
    expect((readError as CrishError).code).toBe("session.not_found");
  });

  // R6: 以下测试覆盖 SessionError -> session.* 迁移的其余 4 个 throw 路径
  it("throws CrishError(session.invalid_state) when readBranchPath detects a cycle", () => {
    // loadEntries 会拒绝循环（parent 必须先于 child 出现），所以 cycle 检测是
    // 防御性代码。这里通过反射式访问内部 byId 来注入循环，验证 defensive throw 仍使用新码。
    const tree = new SessionTree({
      entries: [
        { type: "node", id: "entry_root", parentId: null, createdAt: "2026-01-01T00:00:00.000Z", payload: { text: "root" } },
        { type: "node", id: "entry_a", parentId: "entry_root", createdAt: "2026-01-01T00:00:01.000Z", payload: { text: "a" } }
      ],
      currentLeafId: "entry_a"
    });

    // 反射式注入循环：让 entry_root 的 parentId 指向 entry_a，形成 entry_a -> entry_root -> entry_a
    const internal = tree as unknown as { byId: { set: (k: string, v: SessionTreeEntry) => void; get: (k: string) => SessionTreeEntry | undefined } };
    const root = internal.byId.get("entry_root");
    if (!root) throw new Error("test setup failed: entry_root missing");
    internal.byId.set("entry_root", { ...root, parentId: "entry_a" });

    const error = captureThrow(() => tree.readBranchPath("entry_a"));
    expect(error).toBeInstanceOf(CrishError);
    expect((error as CrishError).code).toBe("session.invalid_state");
    expect((error as CrishError).category).toBe("permanent");
    expect((error as CrishError).retryable).toBe(false);
  });

  it("throws CrishError(session.invalid_entry) when loadEntries sees a duplicate id", () => {
    const error = captureThrow(() =>
      new SessionTree({
        entries: [
          { type: "node", id: "dup", parentId: null, createdAt: "2026-01-01T00:00:00.000Z", payload: { text: "first" } },
          { type: "node", id: "dup", parentId: "dup", createdAt: "2026-01-01T00:00:01.000Z", payload: { text: "second" } }
        ]
      })
    );
    expect(error).toBeInstanceOf(CrishError);
    expect((error as CrishError).code).toBe("session.invalid_entry");
    expect((error as CrishError).category).toBe("permanent");
    expect((error as CrishError).retryable).toBe(false);
  });

  it("throws CrishError(session.not_found) when branch summary references a missing abandoned leaf", () => {
    const error = captureThrow(() =>
      new SessionTree({
        entries: [
          { type: "node", id: "root", parentId: null, createdAt: "2026-01-01T00:00:00.000Z", payload: { text: "root" } },
          {
            type: "branch_summary",
            id: "summary_1",
            parentId: "root",
            createdAt: "2026-01-01T00:00:01.000Z",
            summary: "abandoned",
            abandonedLeafId: "ghost_leaf"
          }
        ]
      })
    );
    expect(error).toBeInstanceOf(CrishError);
    expect((error as CrishError).code).toBe("session.not_found");
  });

  it("throws CrishError(session.invalid_entry) when appending an entry with an existing id", () => {
    const tree = new SessionTree({
      entries: [
        { type: "node", id: "fixed_id", parentId: null, createdAt: "2026-01-01T00:00:00.000Z", payload: { text: "first" } }
      ]
    });

    const error = captureThrow(() =>
      tree.appendNode({ id: "fixed_id", payload: { text: "second" } })
    );
    expect(error).toBeInstanceOf(CrishError);
    expect((error as CrishError).code).toBe("session.invalid_entry");
  });
});

function testTree(): SessionTree {
  let sequence = 0;
  return new SessionTree({
    now: () => `2026-01-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    createId: (prefix) => `${prefix}_${++sequence}`
  });
}

function captureThrow(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected function to throw but it did not");
}
