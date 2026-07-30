import type { JsonObject } from "@crish/shared-types";
import type { ConversationRewindTargetFacts } from "@crish/agent-context";
import { SessionTree, type SessionTreeEntry, type SessionTreeLeafId } from "./session-tree";
import { isTerminalRunStatus } from "./state-machine";
import type { OrchestratorRunRecord, OrchestratorSessionRecord } from "./types";

export type ConversationRewindCancelReason = "conversation-rewind";
export type ConversationRewindRestorePolicy = "if-present" | "required" | "skip";

export type ConversationRewindCheckpointTarget =
  | {
      source: "runtime-manifest";
      checkpointId: string;
      manifestPath?: string;
    }
  | {
      source: "git-checkpoint";
      checkpoint: string;
      cleanUntracked?: boolean;
    };

export interface ConversationRewindPendingApproval {
  toolCallId: string;
  runId: string;
}

export interface ConversationRewindActiveSubagent {
  subagentRunId: string;
  parentRunId: string;
  subagentId?: string;
}

export interface PlanConversationRewindInput<TPayload = JsonObject, TDetails = JsonObject> {
  session: Pick<OrchestratorSessionRecord, "id" | "currentLeafId">;
  entries: readonly SessionTreeEntry<TPayload, TDetails>[];
  targetLeafId: SessionTreeLeafId;
  runs: readonly OrchestratorRunRecord[] | undefined;
  pendingApprovals: readonly ConversationRewindPendingApproval[] | undefined;
  activeSubagents: readonly ConversationRewindActiveSubagent[] | undefined;
  checkpoint: ConversationRewindCheckpointTarget | undefined;
  restorePolicy: ConversationRewindRestorePolicy | undefined;
}

export interface ConversationRewindRunCancellation {
  runId: string;
  reason: ConversationRewindCancelReason;
  role: "session-run" | "subagent-run";
}

export interface ConversationRewindApprovalClearance {
  toolCallId: string;
  runId: string;
  reason: ConversationRewindCancelReason;
}

export interface ConversationRewindWorkspaceRestore {
  required: boolean;
  source: ConversationRewindCheckpointTarget["source"] | "none";
  checkpointId: string | undefined;
  checkpoint: string | undefined;
  manifestPath: string | undefined;
  cleanUntracked: boolean;
}

export type ConversationRewindStep =
  | { type: "cancel-runs"; runs: ConversationRewindRunCancellation[] }
  | { type: "clear-approvals"; approvals: ConversationRewindApprovalClearance[] }
  | { type: "restore-workspace"; restore: ConversationRewindWorkspaceRestore }
  | { type: "move-session-leaf"; sessionId: string; fromLeafId: SessionTreeLeafId; toLeafId: SessionTreeLeafId };

export interface ConversationRewindEntryProjection<TPayload = JsonObject, TDetails = JsonObject> {
  currentPath: SessionTreeEntry<TPayload, TDetails>[];
  targetPath: SessionTreeEntry<TPayload, TDetails>[];
  commonAncestorId?: string;
  retainedEntryIds: string[];
  hiddenEntryIds: string[];
  hiddenCurrentPathEntryIds: string[];
  hiddenBranchEntryIds: string[];
}

export interface ConversationRewindPlan<TPayload = JsonObject, TDetails = JsonObject> {
  sessionId: string;
  fromLeafId: SessionTreeLeafId;
  targetLeafId: SessionTreeLeafId;
  targetPath: SessionTreeEntry<TPayload, TDetails>[];
  entryProjection: ConversationRewindEntryProjection<TPayload, TDetails>;
  runCancellations: ConversationRewindRunCancellation[];
  approvalClearances: ConversationRewindApprovalClearance[];
  workspaceRestore: ConversationRewindWorkspaceRestore;
  steps: ConversationRewindStep[];
}

export interface PlanConversationRewindFromTargetFactsInput<TPayload = JsonObject, TDetails = JsonObject>
  extends Omit<PlanConversationRewindInput<TPayload, TDetails>, "targetLeafId" | "checkpoint"> {
  target: ConversationRewindTargetFacts;
  checkpoint: ConversationRewindCheckpointTarget | undefined;
}

export interface ConversationRewindPlanWithTargetFacts<TPayload = JsonObject, TDetails = JsonObject> {
  plan: ConversationRewindPlan<TPayload, TDetails>;
  runtimeTargetLeafId: string | undefined;
  missingFacts: ConversationRewindTargetFacts["missingFacts"];
}

const REWIND_CANCEL_REASON: ConversationRewindCancelReason = "conversation-rewind";

export function planConversationRewind<TPayload = JsonObject, TDetails = JsonObject>(
  input: PlanConversationRewindInput<TPayload, TDetails>
): ConversationRewindPlan<TPayload, TDetails> {
  const tree = new SessionTree<TPayload, TDetails>({
    entries: input.entries,
    currentLeafId: input.session.currentLeafId
  });
  const targetPath = tree.readBranchPath(input.targetLeafId);
  const entryProjection = projectRewindEntries(tree, input.targetLeafId);
  const runCancellations = planRunCancellations(input.session.id, input.runs ?? [], input.activeSubagents ?? []);
  const cancelledRunIds = new Set(runCancellations.map((run) => run.runId));
  const approvalClearances = (input.pendingApprovals ?? [])
    .filter((approval) => cancelledRunIds.has(approval.runId))
    .map((approval) => ({
      toolCallId: approval.toolCallId,
      runId: approval.runId,
      reason: REWIND_CANCEL_REASON
    }));
  const workspaceRestore = planWorkspaceRestore(input.checkpoint, input.restorePolicy ?? "if-present");
  const fromLeafId = tree.getCurrentLeafId();

  return {
    sessionId: input.session.id,
    fromLeafId,
    targetLeafId: input.targetLeafId,
    targetPath,
    entryProjection,
    runCancellations,
    approvalClearances,
    workspaceRestore,
    steps: compactSteps([
      runCancellations.length > 0 ? { type: "cancel-runs", runs: runCancellations } : undefined,
      approvalClearances.length > 0 ? { type: "clear-approvals", approvals: approvalClearances } : undefined,
      workspaceRestore.source !== "none" ? { type: "restore-workspace", restore: workspaceRestore } : undefined,
      fromLeafId !== input.targetLeafId
        ? { type: "move-session-leaf", sessionId: input.session.id, fromLeafId, toLeafId: input.targetLeafId }
        : undefined
    ])
  };
}

export function projectConversationRewindEntries<TPayload = JsonObject, TDetails = JsonObject>(
  entries: readonly SessionTreeEntry<TPayload, TDetails>[],
  currentLeafId: SessionTreeLeafId | undefined,
  targetLeafId: SessionTreeLeafId
): ConversationRewindEntryProjection<TPayload, TDetails> {
  const tree = new SessionTree<TPayload, TDetails>({ entries, currentLeafId });
  return projectRewindEntries(tree, targetLeafId);
}

export function planConversationRewindFromTargetFacts<TPayload = JsonObject, TDetails = JsonObject>(
  input: PlanConversationRewindFromTargetFactsInput<TPayload, TDetails>
): ConversationRewindPlanWithTargetFacts<TPayload, TDetails> {
  if (!input.target.sessionTreeTargetLeafId) {
    throw new Error("Conversation rewind target is missing session-tree-target-leaf");
  }

  return {
    plan: planConversationRewind({
      ...input,
      targetLeafId: input.target.sessionTreeTargetLeafId,
      checkpoint: input.checkpoint ?? checkpointTargetFromFacts(input.target)
    }),
    runtimeTargetLeafId: input.target.runtimeTargetLeafId ?? undefined,
    missingFacts: [...input.target.missingFacts]
  };
}

function planRunCancellations(
  sessionId: string,
  runs: readonly OrchestratorRunRecord[],
  activeSubagents: readonly ConversationRewindActiveSubagent[]
): ConversationRewindRunCancellation[] {
  const activeSessionRunIds = new Set(
    runs.filter((run) => run.sessionId === sessionId && !isTerminalRunStatus(run.status)).map((run) => run.id)
  );
  const cancellations = new Map<string, ConversationRewindRunCancellation>();

  for (const runId of activeSessionRunIds) {
    cancellations.set(runId, { runId, reason: REWIND_CANCEL_REASON, role: "session-run" });
  }

  for (const subagent of activeSubagents) {
    if (!activeSessionRunIds.has(subagent.parentRunId)) continue;
    const run = runs.find((candidate) => candidate.id === subagent.subagentRunId);
    if (run && isTerminalRunStatus(run.status)) continue;
    cancellations.set(subagent.subagentRunId, {
      runId: subagent.subagentRunId,
      reason: REWIND_CANCEL_REASON,
      role: "subagent-run"
    });
  }

  return [...cancellations.values()];
}

function projectRewindEntries<TPayload, TDetails>(
  tree: SessionTree<TPayload, TDetails>,
  targetLeafId: SessionTreeLeafId
): ConversationRewindEntryProjection<TPayload, TDetails> {
  const currentPath = tree.readBranchPath();
  const targetPath = tree.readBranchPath(targetLeafId);
  const targetIds = new Set(targetPath.map((entry) => entry.id));
  const currentPathIds = new Set(currentPath.map((entry) => entry.id));
  const currentHidden = currentPath.filter((entry) => !targetIds.has(entry.id)).map((entry) => entry.id);
  const hiddenBranchEntryIds = tree
    .getEntries()
    .filter((entry) => !targetIds.has(entry.id) && !currentPathIds.has(entry.id))
    .map((entry) => entry.id);
  const hiddenEntryIds = [...currentHidden, ...hiddenBranchEntryIds];
  const commonAncestorId = lastCommonPathEntryId(currentPath, targetPath);

  return {
    currentPath,
    targetPath,
    ...(commonAncestorId !== undefined ? { commonAncestorId } : {}),
    retainedEntryIds: targetPath.map((entry) => entry.id),
    hiddenEntryIds,
    hiddenCurrentPathEntryIds: currentHidden,
    hiddenBranchEntryIds
  };
}

function lastCommonPathEntryId<TPayload, TDetails>(
  left: readonly SessionTreeEntry<TPayload, TDetails>[],
  right: readonly SessionTreeEntry<TPayload, TDetails>[]
): string | undefined {
  const length = Math.min(left.length, right.length);
  let common: string | undefined;
  for (let index = 0; index < length; index++) {
    if (left[index]?.id !== right[index]?.id) break;
    common = left[index]?.id;
  }
  return common;
}

function planWorkspaceRestore(
  checkpoint: ConversationRewindCheckpointTarget | undefined,
  policy: ConversationRewindRestorePolicy
): ConversationRewindWorkspaceRestore {
  if (policy === "skip") {
    return { required: false, source: "none", cleanUntracked: false, checkpointId: undefined, checkpoint: undefined, manifestPath: undefined };
  }
  if (!checkpoint) {
    if (policy === "required") {
      throw new Error("Conversation rewind requires a workspace checkpoint");
    }
    return { required: false, source: "none", cleanUntracked: false, checkpointId: undefined, checkpoint: undefined, manifestPath: undefined };
  }
  if (checkpoint.source === "runtime-manifest") {
    return {
      required: true,
      source: "runtime-manifest",
      checkpointId: checkpoint.checkpointId,
      manifestPath: checkpoint.manifestPath,
      checkpoint: undefined,
      cleanUntracked: false
    };
  }
  return {
    required: true,
    source: "git-checkpoint",
    checkpoint: checkpoint.checkpoint,
    checkpointId: undefined,
    manifestPath: undefined,
    cleanUntracked: checkpoint.cleanUntracked ?? false
  };
}

function checkpointTargetFromFacts(target: ConversationRewindTargetFacts): ConversationRewindCheckpointTarget | undefined {
  const checkpoint = target.checkpoint;
  if (!checkpoint) return undefined;

  if (checkpoint.checkpointRef.startsWith("refs/")) {
    return {
      source: "git-checkpoint",
      checkpoint: checkpoint.checkpointRef
    };
  }

  return {
    source: "runtime-manifest",
    checkpointId: checkpoint.checkpointId,
    manifestPath: checkpoint.checkpointRef
  };
}

function compactSteps(steps: Array<ConversationRewindStep | undefined>): ConversationRewindStep[] {
  return steps.filter((step): step is ConversationRewindStep => step !== undefined);
}
