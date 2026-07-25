import type { JsonObject } from "@crish/shared-types";

export type WorkbenchSessionTreeLeafId = string | null;
export type WorkbenchSessionTreeEntryType = "node" | "branch_summary";

export interface WorkbenchSessionTreeBaseEntry {
  id: string;
  parentId: string | null;
  createdAt: string;
}

export interface WorkbenchSessionTreeNodeEntry extends WorkbenchSessionTreeBaseEntry {
  type: "node";
  payload: JsonObject;
}

export interface WorkbenchSessionTreeBranchSummaryEntry extends WorkbenchSessionTreeBaseEntry {
  type: "branch_summary";
  summary: string;
  abandonedLeafId: string | null;
  details?: JsonObject;
}

export type WorkbenchSessionTreeEntry =
  | WorkbenchSessionTreeNodeEntry
  | WorkbenchSessionTreeBranchSummaryEntry;

export type WorkbenchConversationRewindBoundaryTargetMode = "keep-user-message" | "remove-user-message";
export type WorkbenchConversationRewindRestorePolicy = "if-present" | "required" | "skip";
export type WorkbenchConversationBoundaryCheckpointSource = "runtime" | "tool" | "external" | "unknown";

export type WorkbenchConversationRewindCheckpointTarget =
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

export interface WorkbenchConversationRewindActiveSubagentRecord {
  parentRunId: string;
  subagentRunId: string;
  subagentId?: string;
}

export interface WorkbenchConversationRewindRequest {
  sessionId: string;
  runId?: string;
  targetLeafId?: WorkbenchSessionTreeLeafId;
  entries?: WorkbenchSessionTreeEntry[];
  userMessageId?: string;
  latestUserMessage?: boolean;
  mode?: WorkbenchConversationRewindBoundaryTargetMode;
  retainTargetUserMessage?: boolean;
  checkpoint?: WorkbenchConversationRewindCheckpointTarget;
  restorePolicy?: WorkbenchConversationRewindRestorePolicy;
  activeSubagents?: WorkbenchConversationRewindActiveSubagentRecord[];
  dryRun?: boolean;
  force?: boolean;
}

export type WorkbenchConversationRewindPreviewRequest = WorkbenchConversationRewindRequest;
export type WorkbenchConversationRewindApplyRequest = WorkbenchConversationRewindRequest;

export type WorkbenchCapabilityState =
  | "implemented"
  | "experimental"
  | "degraded"
  | "backend-not-wired"
  | "unsupported";

export type WorkbenchSessionActionAvailability = WorkbenchCapabilityState;

export type WorkbenchSessionActionId =
  | "pin"
  | "unpin"
  | "fork"
  | "rename"
  | "archive"
  | "unarchive"
  | "delete"
  | "open-in"
  | "open-in-split-view"
  | "rewind"
  | "withdraw";

export type WorkbenchSessionActionEffect =
  | "metadata"
  | "branch"
  | "navigation"
  | "history-mutation"
  | "message-mutation";

export interface WorkbenchSessionActionContract {
  id: WorkbenchSessionActionId;
  label: string;
  availability: WorkbenchSessionActionAvailability;
  effect: WorkbenchSessionActionEffect;
  backendCommand?: string;
  daemonCapability?: string;
  reason: string;
}

export const WORKBENCH_SESSION_ACTION_PROTOCOL_VERSION = 1;

export type WorkbenchSessionActionKind =
  | "pin"
  | "unpin"
  | "fork"
  | "rename"
  | "archive"
  | "unarchive"
  | "delete"
  | "rewind"
  | "open";

export type WorkbenchSessionOpenTarget = "split-view" | "vscode" | "explorer";
export type WorkbenchSessionActionStatus = "pending" | "committed" | "rejected" | "failed";

export interface WorkbenchSessionActionBase {
  protocolVersion: typeof WORKBENCH_SESSION_ACTION_PROTOCOL_VERSION;
  actionId: string;
  kind: WorkbenchSessionActionKind;
  sessionId: string;
  requestedAt: string;
  requestedBy: "workbench" | "daemon" | "automation";
  idempotencyKey?: string;
  consistency?: {
    expectedSessionVersion?: string;
    eventLogCursor?: string;
    workspaceVersionId?: string;
    parentActionId?: string;
  };
}

export type WorkbenchSessionAction =
  | (WorkbenchSessionActionBase & { kind: "pin" | "unpin" | "archive" | "unarchive" | "delete" })
  | (WorkbenchSessionActionBase & { kind: "rename"; title: string })
  | (WorkbenchSessionActionBase & {
      kind: "fork";
      fromEventId?: string;
      fromMessageId?: string;
      targetSessionId?: string;
    })
  | (WorkbenchSessionActionBase & { kind: "rewind"; targetEventId: string; restoreWorkspace: boolean })
  | (WorkbenchSessionActionBase & { kind: "open"; target: WorkbenchSessionOpenTarget; paneId?: string });

export interface WorkbenchSessionActionReceipt {
  type?: "session-action-receipt";
  protocolVersion: typeof WORKBENCH_SESSION_ACTION_PROTOCOL_VERSION;
  actionId: string;
  kind: WorkbenchSessionActionKind;
  sessionId: string;
  status: WorkbenchSessionActionStatus;
  committedAt?: string;
  resultingSessionId?: string;
  resultingEventId?: string;
  resultingWorkspaceVersionId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export const WORKBENCH_SESSION_ACTIONS: readonly WorkbenchSessionActionContract[] = [
  {
    id: "pin",
    label: "Pin",
    availability: "implemented",
    effect: "metadata",
    backendCommand: "workbench_apply_session_action",
    daemonCapability: "session.apply-action",
    reason: "Pinning is persisted through daemon apply-session-action metadata.",
  },
  {
    id: "unpin",
    label: "Unpin",
    availability: "implemented",
    effect: "metadata",
    backendCommand: "workbench_apply_session_action",
    daemonCapability: "session.apply-action",
    reason: "Unpinning is persisted through daemon apply-session-action metadata.",
  },
  {
    id: "rename",
    label: "Rename",
    availability: "implemented",
    effect: "metadata",
    backendCommand: "workbench_apply_session_action",
    daemonCapability: "session.apply-action",
    reason: "Renaming is persisted through daemon apply-session-action metadata.",
  },
  {
    id: "archive",
    label: "Archive",
    availability: "implemented",
    effect: "metadata",
    backendCommand: "workbench_apply_session_action",
    daemonCapability: "session.apply-action",
    reason: "Archiving is persisted through daemon apply-session-action metadata.",
  },
  {
    id: "unarchive",
    label: "Unarchive",
    availability: "implemented",
    effect: "metadata",
    backendCommand: "workbench_apply_session_action",
    daemonCapability: "session.apply-action",
    reason: "Unarchiving is persisted through daemon apply-session-action metadata.",
  },
  {
    id: "delete",
    label: "Delete",
    availability: "implemented",
    effect: "metadata",
    backendCommand: "workbench_apply_session_action",
    daemonCapability: "session.apply-action",
    reason: "Deletion is a daemon-owned soft tombstone persisted through apply-session-action metadata.",
  },
  {
    id: "fork",
    label: "Fork",
    availability: "unsupported",
    effect: "branch",
    reason: "Forking needs a daemon session-branch command; it must not be represented by conversation rewind.",
  },
  {
    id: "open-in",
    label: "Open in",
    availability: "experimental",
    effect: "navigation",
    backendCommand: "workbench_apply_session_action",
    daemonCapability: "session.apply-action",
    reason: "Open is a daemon intent receipt; Workbench target handling remains experimental.",
  },
  {
    id: "open-in-split-view",
    label: "Open in split view",
    availability: "experimental",
    effect: "navigation",
    backendCommand: "workbench_apply_session_action",
    daemonCapability: "session.apply-action",
    reason: "Split-view open is a daemon intent receipt while layout binding is still experimental.",
  },
  {
    id: "rewind",
    label: "Rewind",
    availability: "implemented",
    effect: "history-mutation",
    backendCommand: "workbench_apply_conversation_rewind",
    daemonCapability: "conversation.rewind",
    reason: "Conversation rewind uses the daemon preview/apply protocol and may return unsupported step results.",
  },
  {
    id: "withdraw",
    label: "Withdraw",
    availability: "backend-not-wired",
    effect: "message-mutation",
    reason: "Withdrawing a message needs its own daemon command and must not be collapsed into rewind apply.",
  },
] as const;

export interface WorkbenchConversationBoundaryRecord {
  sessionId: string;
  runId: string;
  userMessageId: string;
  sessionTreeLeafIdBefore?: string;
  sessionTreeLeafIdAfter?: string;
  runtimeLeafIdBefore?: string;
  runtimeLeafIdAfter?: string;
  eventSequence: number;
  workspaceRoot: string;
  checkpointId?: string;
  checkpointRef?: string;
  checkpointSource?: WorkbenchConversationBoundaryCheckpointSource;
  changedPaths: string[];
  createdAt: string;
  metadata?: JsonObject;
}

export interface WorkbenchConversationCheckpointRecord {
  sessionId: string;
  runId: string;
  userMessageId: string;
  checkpointId: string;
  checkpointRef: string;
  workspaceRoot: string;
  changedPaths: string[];
  source: WorkbenchConversationBoundaryCheckpointSource;
  createdAt: string;
  metadata?: JsonObject;
}

export type WorkbenchConversationRewindMissingFact =
  | "session-tree-target-leaf"
  | "runtime-target-leaf"
  | "workspace-checkpoint";

export type WorkbenchConversationRewindBoundaryMissingFact =
  | WorkbenchConversationRewindMissingFact
  | "boundary-record"
  | "checkpoint-manifest-record"
  | "session-record"
  | "session-tree-entries";

export interface WorkbenchConversationRewindWorkspaceCheckpointFacts {
  checkpointId: string;
  checkpointRef: string;
  checkpointSource: WorkbenchConversationBoundaryCheckpointSource;
  workspaceRoot: string;
  changedPaths: string[];
  createdAt: string;
}

export interface WorkbenchConversationRewindTargetFacts {
  sessionId: string;
  runId: string;
  userMessageId: string;
  mode: WorkbenchConversationRewindBoundaryTargetMode;
  eventSequence: number;
  workspaceRoot: string;
  changedPaths: string[];
  createdAt: string;
  sessionTreeTargetLeafId?: string;
  runtimeTargetLeafId?: string;
  checkpoint?: WorkbenchConversationRewindWorkspaceCheckpointFacts;
  missingFacts: WorkbenchConversationRewindMissingFact[];
  metadata?: JsonObject;
}

export interface WorkbenchConversationRewindBoundaryDiagnostic {
  code: string;
  fact: WorkbenchConversationRewindBoundaryMissingFact;
  message: string;
  blocked: boolean;
  metadata?: JsonObject;
}

export interface WorkbenchConversationRewindRunCancellation {
  runId: string;
  reason: "conversation-rewind";
  role: "session-run" | "subagent-run";
}

export interface WorkbenchConversationRewindApprovalClearance {
  toolCallId: string;
  runId: string;
  reason: "conversation-rewind";
}

export interface WorkbenchConversationRewindWorkspaceRestore {
  required: boolean;
  source: "runtime-manifest" | "git-checkpoint" | "none";
  checkpointId?: string;
  checkpoint?: string;
  manifestPath?: string;
  cleanUntracked: boolean;
}

export type WorkbenchConversationRewindStep =
  | { type: "cancel-runs"; runs: WorkbenchConversationRewindRunCancellation[] }
  | { type: "clear-approvals"; approvals: WorkbenchConversationRewindApprovalClearance[] }
  | { type: "restore-workspace"; restore: WorkbenchConversationRewindWorkspaceRestore }
  | {
      type: "move-session-leaf";
      sessionId: string;
      fromLeafId: WorkbenchSessionTreeLeafId;
      toLeafId: WorkbenchSessionTreeLeafId;
    };

export interface WorkbenchConversationRewindEntryProjection {
  currentPath: WorkbenchSessionTreeEntry[];
  targetPath: WorkbenchSessionTreeEntry[];
  commonAncestorId?: string;
  retainedEntryIds: string[];
  hiddenEntryIds: string[];
  hiddenCurrentPathEntryIds: string[];
  hiddenBranchEntryIds: string[];
}

export interface WorkbenchConversationRewindPlan {
  sessionId: string;
  fromLeafId: WorkbenchSessionTreeLeafId;
  targetLeafId: WorkbenchSessionTreeLeafId;
  targetPath: WorkbenchSessionTreeEntry[];
  entryProjection: WorkbenchConversationRewindEntryProjection;
  runCancellations: WorkbenchConversationRewindRunCancellation[];
  approvalClearances: WorkbenchConversationRewindApprovalClearance[];
  workspaceRestore: WorkbenchConversationRewindWorkspaceRestore;
  steps: WorkbenchConversationRewindStep[];
}

export interface WorkbenchConversationRewindPreviewResponse {
  type?: "conversation-rewind-preview";
  sessionId: string;
  plan: WorkbenchConversationRewindPlan;
  requestId?: string;
  correlationId?: string;
}

export interface WorkbenchConversationRewindBoundaryResponse {
  type?: "conversation-rewind-boundary";
  status: "ok" | "blocked";
  sessionId: string;
  userMessageId?: string;
  latestUserMessage: boolean;
  mode: WorkbenchConversationRewindBoundaryTargetMode;
  boundary?: WorkbenchConversationBoundaryRecord;
  checkpoint?: WorkbenchConversationCheckpointRecord;
  target?: WorkbenchConversationRewindTargetFacts;
  missingFacts: WorkbenchConversationRewindBoundaryMissingFact[];
  diagnostics: WorkbenchConversationRewindBoundaryDiagnostic[];
  plan?: WorkbenchConversationRewindPlan;
  runtimeTargetLeafId?: string;
  requestId?: string;
  correlationId?: string;
}

export type WorkbenchConversationRewindPreviewResult =
  | WorkbenchConversationRewindPreviewResponse
  | WorkbenchConversationRewindBoundaryResponse;

export type WorkbenchConversationRewindApplyStepStatus =
  | "applied"
  | "deferred"
  | "unsupported"
  | "skipped"
  | "failed";

export interface WorkbenchConversationRewindApplyStepResult {
  type: WorkbenchConversationRewindStep["type"];
  status: WorkbenchConversationRewindApplyStepStatus;
  code?: string;
  message?: string;
  affectedIds?: string[];
  metadata?: JsonObject;
}

export interface WorkbenchConversationRewindAppliedResponse {
  type?: "conversation-rewind-applied";
  sessionId: string;
  plan: WorkbenchConversationRewindPlan;
  stepResults: WorkbenchConversationRewindApplyStepResult[];
  requestId?: string;
  correlationId?: string;
}
