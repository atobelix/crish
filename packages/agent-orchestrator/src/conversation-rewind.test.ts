import { describe, expect, it } from "vitest";
import { CrishError } from "@crish/shared-types";
import {
  planConversationRewind,
  planConversationRewindFromTargetFacts,
  projectConversationRewindEntries,
  type ConversationRewindCheckpointTarget
} from "./conversation-rewind";
import type { SessionTreeEntry } from "./session-tree";
import type { OrchestratorRunRecord } from "./types";
import { createConversationBoundaryManifestRecord, resolveConversationRewindTargetFacts } from "@crish/agent-context";

describe("planConversationRewind", () => {
  it("plans run cancellation, approval clearing, checkpoint restore, and leaf movement in order", () => {
    const plan = planConversationRewind({
      session: { id: "session_a", currentLeafId: "leaf_current" },
      entries: entries(),
      targetLeafId: "leaf_target",
      runs: [
        run({ id: "run_active", sessionId: "session_a", status: "awaiting-approval" }),
        run({ id: "run_done", sessionId: "session_a", status: "completed" }),
        run({ id: "run_other", sessionId: "session_b", status: "running" }),
        run({ id: "run_sub", sessionId: "session_sub", status: "running" })
      ],
      pendingApprovals: [
        { toolCallId: "approval_active", runId: "run_active" },
        { toolCallId: "approval_other", runId: "run_other" },
        { toolCallId: "approval_sub", runId: "run_sub" }
      ],
      activeSubagents: [{ parentRunId: "run_active", subagentRunId: "run_sub", subagentId: "sub_1" }],
      checkpoint: { source: "git-checkpoint", checkpoint: "git_checkpoint_1" },
      restorePolicy: undefined,
    });

    expect(plan.fromLeafId).toBe("leaf_current");
    expect(plan.targetPath.map((entry) => entry.id)).toEqual(["root", "leaf_target"]);
    expect(plan.entryProjection).toMatchObject({
      commonAncestorId: "root",
      retainedEntryIds: ["root", "leaf_target"],
      hiddenCurrentPathEntryIds: ["leaf_current"]
    });
    expect(plan.runCancellations).toEqual([
      { runId: "run_active", reason: "conversation-rewind", role: "session-run" },
      { runId: "run_sub", reason: "conversation-rewind", role: "subagent-run" }
    ]);
    expect(plan.approvalClearances.map((approval) => approval.toolCallId)).toEqual(["approval_active", "approval_sub"]);
    expect(plan.workspaceRestore).toMatchObject({
      source: "git-checkpoint",
      checkpoint: "git_checkpoint_1",
      cleanUntracked: false
    });
    expect(plan.steps.map((step) => step.type)).toEqual([
      "cancel-runs",
      "clear-approvals",
      "restore-workspace",
      "move-session-leaf"
    ]);
  });

  it("normalizes runtime manifest checkpoint restores without requiring git cleanup", () => {
    const checkpoint: ConversationRewindCheckpointTarget = {
      source: "runtime-manifest",
      checkpointId: "checkpoint_1",
      manifestPath: "C:/repo/.agent-runtime/checkpoint.json"
    };

    const plan = planConversationRewind({
      session: { id: "session_a", currentLeafId: "leaf_current" },
      entries: entries(),
      targetLeafId: "leaf_target",
      checkpoint,
      runs: undefined,
      pendingApprovals: undefined,
      activeSubagents: undefined,
      restorePolicy: undefined,
    });

    expect(plan.workspaceRestore).toEqual({
      required: true,
      source: "runtime-manifest",
      checkpointId: "checkpoint_1",
      manifestPath: "C:/repo/.agent-runtime/checkpoint.json",
      cleanUntracked: false
    });
  });

  it("allows tree-only rewind planning when workspace restore is skipped", () => {
    const plan = planConversationRewind({
      session: { id: "session_a", currentLeafId: "leaf_current" },
      entries: entries(),
      targetLeafId: "leaf_target",
      runs: undefined,
      pendingApprovals: undefined,
      activeSubagents: undefined,
      checkpoint: undefined,
      restorePolicy: "skip"
    });

    expect(plan.workspaceRestore).toEqual({ required: false, source: "none", cleanUntracked: false });
    expect(plan.steps.map((step) => step.type)).toEqual(["move-session-leaf"]);
  });

  it("projects hidden entries without deleting append-only history", () => {
    const projection = projectConversationRewindEntries(
      [
        node("root", null),
        node("target", "root"),
        node("current_1", "root"),
        node("current_2", "current_1"),
        node("other_branch", "root"),
        {
          type: "branch_summary",
          id: "summary_other",
          parentId: "target",
          createdAt: "2026-01-01T00:00:05.000Z",
          summary: "Other branch summarized",
          abandonedLeafId: "other_branch"
        }
      ],
      "current_2",
      "summary_other"
    );

    expect(projection.currentPath.map((entry) => entry.id)).toEqual(["root", "current_1", "current_2"]);
    expect(projection.targetPath.map((entry) => entry.id)).toEqual(["root", "target", "summary_other"]);
    expect(projection.commonAncestorId).toBe("root");
    expect(projection.retainedEntryIds).toEqual(["root", "target", "summary_other"]);
    expect(projection.hiddenCurrentPathEntryIds).toEqual(["current_1", "current_2"]);
    expect(projection.hiddenBranchEntryIds).toEqual(["other_branch"]);
    expect(projection.hiddenEntryIds).toEqual(["current_1", "current_2", "other_branch"]);
  });

  it("rejects missing required workspace checkpoints and invalid tree targets", () => {
    // R6: throw new Error -> CrishError("store.write_failed", transient, retryable=true)
    const checkpointError = captureThrow(() =>
      planConversationRewind({
        session: { id: "session_a", currentLeafId: "leaf_current" },
        entries: entries(),
        targetLeafId: "leaf_target",
        runs: undefined,
        pendingApprovals: undefined,
        activeSubagents: undefined,
        checkpoint: undefined,
        restorePolicy: "required"
      })
    );
    expect(checkpointError).toBeInstanceOf(CrishError);
    expect((checkpointError as CrishError).code).toBe("store.write_failed");
    expect((checkpointError as CrishError).category).toBe("transient");
    expect((checkpointError as CrishError).retryable).toBe(true);

    // R6: readBranchPath 在 session-tree.ts 中抛出 session.not_found
    const missingTargetError = captureThrow(() =>
      planConversationRewind({
        session: { id: "session_a", currentLeafId: "leaf_current" },
        entries: entries(),
        targetLeafId: "missing",
        runs: undefined,
        pendingApprovals: undefined,
        activeSubagents: undefined,
        checkpoint: undefined,
        restorePolicy: undefined,
      })
    );
    expect(missingTargetError).toBeInstanceOf(CrishError);
    expect((missingTargetError as CrishError).code).toBe("session.not_found");
  });

  it("plans from resolved runtime rewind target facts without changing the daemon plan shape", () => {
    const target = resolveConversationRewindTargetFacts({
      boundary: createConversationBoundaryManifestRecord({
        sessionId: "session_a",
        runId: "run_boundary",
        userMessageId: "msg_user_1",
        sessionTreeLeafIdBefore: "root",
        sessionTreeLeafIdAfter: "leaf_target",
        runtimeLeafIdBefore: "runtime_root",
        runtimeLeafIdAfter: "runtime_leaf_target",
        eventSequence: 8,
        workspaceRoot: "C:/repo",
        checkpointId: "checkpoint_1",
        checkpointRef: "checkpoint://runtime/1",
        checkpointSource: "runtime",
        changedPaths: ["src/file.ts"],
        createdAt: "2026-01-01T00:00:00.000Z"
      })
    });

    const result = planConversationRewindFromTargetFacts({
      session: { id: "session_a", currentLeafId: "leaf_current" },
      entries: entries(),
      target,
      runs: undefined,
      pendingApprovals: undefined,
      activeSubagents: undefined,
      checkpoint: undefined,
      restorePolicy: "if-present"
    });

    expect(result.runtimeTargetLeafId).toBe("runtime_leaf_target");
    expect(result.missingFacts).toEqual([]);
    expect(result.plan.targetLeafId).toBe("leaf_target");
    expect(result.plan.targetPath.map((entry) => entry.id)).toEqual(["root", "leaf_target"]);
    expect(result.plan.workspaceRestore).toMatchObject({
      source: "runtime-manifest",
      checkpointId: "checkpoint_1",
      manifestPath: "checkpoint://runtime/1"
    });
  });

  it("rejects target facts without a product session-tree leaf", () => {
    const target = resolveConversationRewindTargetFacts({
      boundary: createConversationBoundaryManifestRecord({
        sessionId: "session_a",
        runId: "run_boundary",
        userMessageId: "msg_user_1",
        runtimeLeafIdAfter: "runtime_leaf_target",
        eventSequence: 8,
        workspaceRoot: "C:/repo",
        changedPaths: [],
        createdAt: "2026-01-01T00:00:00.000Z"
      })
    });

    // R6: throw new Error -> CrishError("session.invalid_state", permanent, retryable=false)
    const error = captureThrow(() =>
      planConversationRewindFromTargetFacts({
        session: { id: "session_a", currentLeafId: "leaf_current" },
        entries: entries(),
        target,
        runs: undefined,
        pendingApprovals: undefined,
        activeSubagents: undefined,
        checkpoint: undefined,
        restorePolicy: undefined,
      })
    );
    expect(error).toBeInstanceOf(CrishError);
    expect((error as CrishError).code).toBe("session.invalid_state");
    expect((error as CrishError).category).toBe("permanent");
    expect((error as CrishError).retryable).toBe(false);
  });
});

function entries(): SessionTreeEntry[] {
  return [
    node("root", null),
    node("leaf_target", "root", "target"),
    node("leaf_current", "root", "current")
  ];
}

function node(id: string, parentId: string | null, text = id): SessionTreeEntry {
  return {
    type: "node",
    id,
    parentId,
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: { text }
  };
}

function run(input: Pick<OrchestratorRunRecord, "id" | "sessionId" | "status">): OrchestratorRunRecord {
  return {
    id: input.id,
    sessionId: input.sessionId,
    cwd: "C:/repo",
    status: input.status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function captureThrow(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected function to throw but it did not");
}
