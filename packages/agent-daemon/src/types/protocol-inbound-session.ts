import type { JsonObject, SessionAction } from "@crish/shared-types";
import type {
  CreatePlanDocumentInput,
  PlanDocumentPatch,
  ConversationRewindBoundaryTargetMode,
  ScopedContextResolverProject,
  ScopedContextScope,
  ScopedContextKind,
} from "@crish/agent-runtime";
import type {
  ConversationRewindCheckpointTarget,
  ConversationRewindRestorePolicy,
} from "@crish/agent-orchestrator";
import type {
  PendingInputMode,
  PendingInputRecord,
  SessionTreeEntry,
} from "@crish/agent-orchestrator";

import type {
  DaemonBackgroundTaskSnapshot,
} from "./snapshot-types.js";
import type {
  DaemonEventReplayCursor,
  WorkflowSchedule,
  ScopedContextRuntimeConfig,
  ScopedContextRecord,
  ConversationRewindActiveSubagentRecord,
} from "./entities.js";
import type { DaemonCorrelationFields, HelloMessage, PingMessage } from "./protocol-inbound-auth.js";
import type {
  RunTaskMessage,
  ApproveToolMessage,
  DenyToolMessage,
  CancelRunMessage,
  StreamPauseMessage,
  StreamResumeMessage,
} from "./protocol-inbound-run.js";
import type {
  GetStatusMessage,
  ListCapabilitiesMessage,
  UpdateConfigMessage,
  ProbeProviderModelsMessage,
  ProbeProviderChatMessage,
} from "./protocol-inbound-diagnostic.js";

export interface EnqueuePendingInputMessage {
  type: "enqueue-pending-input";
  sessionId: string;
  text: string;
  runId?: string;
  mode?: PendingInputMode;
  inputId?: string;
  source?: PendingInputRecord["source"];
  metadata?: JsonObject;
}

export interface CancelPendingInputMessage {
  type: "cancel-pending-input";
  inputId: string;
  sessionId?: string;
  reason?: string;
}

export interface DispatchPendingInputMessage {
  type: "dispatch-pending-input";
  inputId: string;
  sessionId?: string;
  targetRunId?: string;
}

export interface ListPendingInputsMessage {
  type: "list-pending-inputs";
  sessionId?: string;
}

export interface ListSessionsMessage {
  type: "list-sessions";
  includeArchived?: boolean;
  includeDeleted?: boolean;
}

export interface ListRunsMessage {
  type: "list-runs";
  sessionId?: string;
}

export interface ReadSessionEventsMessage {
  type: "read-session-events";
  sessionId: string;
  afterSequence?: number;
  lastEventId?: string;
  maxEvents?: number;
  cursor?: DaemonEventReplayCursor;
}

export interface ReadRunEventsMessage {
  type: "read-run-events";
  runId: string;
  afterSequence?: number;
  lastEventId?: string;
  includeSnapshot?: boolean;
  maxEvents?: number;
  cursor?: DaemonEventReplayCursor;
}

export interface GetRunSnapshotMessage {
  type: "get-run-snapshot";
  runId: string;
}

export interface ListWorkflowsMessage {
  type: "list-workflows";
}

export interface CreateWorkflowMessage {
  type: "create-workflow";
  id?: string;
  name: string;
  prompt: string;
  cwd?: string;
  mode?: string;
  schedule: WorkflowSchedule;
  enabled?: boolean;
  metadata?: JsonObject;
}

export interface UpdateWorkflowMessage {
  type: "update-workflow";
  workflowId: string;
  name?: string;
  prompt?: string;
  cwd?: string;
  mode?: string;
  schedule?: WorkflowSchedule;
  enabled?: boolean;
  metadata?: JsonObject;
}

export interface DeleteWorkflowMessage {
  type: "delete-workflow";
  workflowId: string;
}

export interface TriggerWorkflowMessage {
  type: "trigger-workflow";
  workflowId: string;
  runId?: string;
  sessionId?: string;
}

export interface ListWorkflowRunsMessage {
  type: "list-workflow-runs";
  workflowId?: string;
}

export interface GitStatusMessage {
  type: "git-status";
  cwd?: string;
}

export interface GitDiffMessage {
  type: "git-diff";
  cwd?: string;
  path?: string;
  staged?: boolean;
}

export interface ListPlanDocumentsMessage {
  type: "list-plan-documents";
}

export interface CreatePlanDocumentMessage extends CreatePlanDocumentInput {
  type: "create-plan-document";
}

export interface CreateRequirementsAlignmentPlanMessage {
  type: "create-requirements-alignment-plan";
  id?: string;
  title?: string;
  goal: string;
  context?: string;
  questions?: string[];
  assumptions?: string[];
  acceptance?: string[];
  risks?: string[];
  source?: "user" | "assistant" | "slash-command" | "workflow" | "system";
  metadata?: JsonObject;
}

export interface GetPlanDocumentMessage {
  type: "get-plan-document";
  documentId: string;
}

export interface PatchPlanDocumentMessage {
  type: "patch-plan-document";
  documentId: string;
  patch: PlanDocumentPatch;
}

export interface DeletePlanDocumentMessage {
  type: "delete-plan-document";
  documentId: string;
}

export interface ListMutationLeasesMessage {
  type: "list-mutation-leases";
  cwd?: string;
}

export interface ListBackgroundTasksMessage {
  type: "list-background-tasks";
  includeHistory?: boolean;
  state?: DaemonBackgroundTaskSnapshot["state"];
  limit?: number;
}

export interface StartBackgroundTaskMessage {
  type: "start-background-task";
  command: string;
  cwd?: string;
  workspaceRoot?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  heartbeatIntervalMs?: number;
}

export interface CancelBackgroundTaskMessage {
  type: "cancel-background-task";
  taskId: string;
}

export interface GetBackgroundTaskHistoryMessage {
  type: "get-background-task-history";
  state?: DaemonBackgroundTaskSnapshot["state"];
  limit?: number;
}

export interface ListArtifactsMessage {
  type: "list-artifacts";
  sessionId?: string;
}

export interface GetArtifactContentMessage {
  type: "get-artifact-content";
  artifactUri: string;
}

export interface ListMemoriesMessage {
  type: "list-memories";
  scope?: string;
}

export interface DeleteMemoryMessage {
  type: "delete-memory";
  memoryId: string;
}

export interface ListCheckpointsMessage {
  type: "list-checkpoints";
  runId?: string;
  sessionId?: string;
}

export interface RestoreCheckpointMessage {
  type: "restore-checkpoint";
  checkpointId: string;
}

export interface GetCheckpointDiffMessage {
  type: "get-checkpoint-diff";
  checkpointId: string;
}

export interface ResolveConversationRewindBoundaryMessage {
  type: "resolve-conversation-rewind-boundary";
  sessionId: string;
  userMessageId?: string;
  latestUserMessage?: boolean;
  mode?: ConversationRewindBoundaryTargetMode;
}

export interface PreviewConversationRewindMessage {
  type: "preview-conversation-rewind";
  sessionId: string;
  targetLeafId: string | null;
  entries: SessionTreeEntry[];
  checkpoint?: ConversationRewindCheckpointTarget;
  restorePolicy?: ConversationRewindRestorePolicy;
  activeSubagents?: ConversationRewindActiveSubagentRecord[];
}

export interface PreviewConversationRewindByBoundaryMessage {
  type: "preview-conversation-rewind-by-boundary";
  sessionId: string;
  userMessageId?: string;
  latestUserMessage?: boolean;
  mode?: ConversationRewindBoundaryTargetMode;
  restorePolicy?: ConversationRewindRestorePolicy;
  activeSubagents?: ConversationRewindActiveSubagentRecord[];
}

export interface ApplyConversationRewindMessage {
  type: "apply-conversation-rewind";
  sessionId: string;
  targetLeafId?: string | null;
  entries?: SessionTreeEntry[];
  userMessageId?: string;
  latestUserMessage?: boolean;
  mode?: ConversationRewindBoundaryTargetMode;
  checkpoint?: ConversationRewindCheckpointTarget;
  restorePolicy?: ConversationRewindRestorePolicy;
  activeSubagents?: ConversationRewindActiveSubagentRecord[];
}

export interface ApplySessionActionMessage {
  type: "apply-session-action";
  action: SessionAction;
}

export interface SendToSubagentMessage {
  type: "send-to-subagent";
  subagentRunId: string;
  message: string;
}

export interface GetSubagentStatusMessage {
  type: "get-subagent-status";
  subagentRunId: string;
}

export interface StartMcpServerMessage {
  type: "start-mcp-server";
  serverId: string;
}

export interface StopMcpServerMessage {
  type: "stop-mcp-server";
  serverId: string;
}

export interface ListMcpServersMessage {
  type: "list-mcp-servers";
}

export interface GetScopedContextMessage {
  type: "get-scoped-context";
  scope?: ScopedContextScope;
  kind?: ScopedContextKind;
}

export interface UpsertScopedContextMessage {
  type: "upsert-scoped-context";
  record: ScopedContextRecord;
}

export interface DeleteScopedContextMessage {
  type: "delete-scoped-context";
  recordId: string;
}

export interface ResolveScopedContextMessage extends ScopedContextResolverProject {
  type: "resolve-scoped-context";
  userEnabledIds?: string[];
  userDisabledIds?: string[];
  scopedContextConfig?: ScopedContextRuntimeConfig;
}

export type DaemonInboundMessage = (
  | RunTaskMessage
  | ApproveToolMessage
  | DenyToolMessage
  | CancelRunMessage
  | StreamPauseMessage
  | StreamResumeMessage
  | HelloMessage
  | PingMessage
  | GetStatusMessage
  | ListCapabilitiesMessage
  | UpdateConfigMessage
  | ListSessionsMessage
  | ListRunsMessage
  | ReadSessionEventsMessage
  | ReadRunEventsMessage
  | GetRunSnapshotMessage
  | EnqueuePendingInputMessage
  | CancelPendingInputMessage
  | DispatchPendingInputMessage
  | ListPendingInputsMessage
  | ListWorkflowsMessage
  | CreateWorkflowMessage
  | UpdateWorkflowMessage
  | DeleteWorkflowMessage
  | TriggerWorkflowMessage
  | ListWorkflowRunsMessage
  | GitStatusMessage
  | GitDiffMessage
  | ListPlanDocumentsMessage
  | CreatePlanDocumentMessage
  | CreateRequirementsAlignmentPlanMessage
  | GetPlanDocumentMessage
  | PatchPlanDocumentMessage
  | DeletePlanDocumentMessage
  | ListMutationLeasesMessage
  | ListBackgroundTasksMessage
  | StartBackgroundTaskMessage
  | CancelBackgroundTaskMessage
  | GetBackgroundTaskHistoryMessage
  | ListArtifactsMessage
  | GetArtifactContentMessage
  | ListMemoriesMessage
  | DeleteMemoryMessage
  | ListCheckpointsMessage
  | RestoreCheckpointMessage
  | GetCheckpointDiffMessage
  | ResolveConversationRewindBoundaryMessage
  | PreviewConversationRewindMessage
  | PreviewConversationRewindByBoundaryMessage
  | ApplyConversationRewindMessage
  | ApplySessionActionMessage
  | SendToSubagentMessage
  | GetSubagentStatusMessage
  | StartMcpServerMessage
  | StopMcpServerMessage
  | ListMcpServersMessage
  | GetScopedContextMessage
  | UpsertScopedContextMessage
  | DeleteScopedContextMessage
  | ResolveScopedContextMessage
  | ProbeProviderModelsMessage
  | ProbeProviderChatMessage
) & DaemonCorrelationFields;
