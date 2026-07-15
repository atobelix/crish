// Protocol source guard: register message types and capability groups before
// adding validators here. Registry tests keep allowlists, groups, and switch
// cases aligned so schema.ts does not become a second independent protocol map.
import type { JsonObject } from "@crish/shared-types";
import { validatePlanDocument } from "@crish/agent-runtime";
import { isRecord as isRecordShared, isJsonObject, isJsonValue } from "@crish/shared-utils";
import {
  SESSION_ACTION_KINDS,
  SESSION_ACTION_PROTOCOL_VERSION,
  SESSION_ACTION_STATUSES,
  SESSION_OPEN_TARGETS,
  type SessionAction,
  type SessionActionKind,
  type SessionActionReceipt,
} from "@crish/shared-types";
import type {
  ApplySessionActionMessage,
  ApproveToolMessage,
  ApprovalRequestedMessage,
  ApprovalResolvedMessage,
  BackgroundTaskCancelledMessage,
  BackgroundTaskHistoryMessage,
  BackgroundTaskStartedMessage,
  BackgroundTasksListedMessage,
  CancelRunMessage,
  CancelPendingInputMessage,
  DispatchPendingInputMessage,
  CancelBackgroundTaskMessage,
  ApplyConversationRewindMessage,
  CapabilitiesResponseMessage,
  ConfigUpdatedMessage,
  ConversationRewindAppliedMessage,
  ConversationRewindPreviewMessage,
  DaemonEventCursorDiagnostic,
  DaemonEventReplayCursor,
  CreateRequirementsAlignmentPlanMessage,
  CreateWorkflowMessage,
  CreatePlanDocumentMessage,
  DaemonInboundMessage,
  DaemonOutboundMessage,
  DaemonReadyMessage,
  DeleteWorkflowMessage,
  DeletePlanDocumentMessage,
  DenyToolMessage,
  ErrorMessage,
  EventMessage,
  ArtifactContentMessage,
  ArtifactsListedMessage,
  CheckpointDiffMessage,
  CheckpointRestoredMessage,
  CheckpointsListedMessage,
  ConversationRewindBoundaryMessage,
  DeleteMemoryMessage,
  GetArtifactContentMessage,
  GetBackgroundTaskHistoryMessage,
  GetCheckpointDiffMessage,
  GitDiffMessage,
  GitDiffResponseMessage,
  GitStatusMessage,
  GitStatusResponseMessage,
  GetPlanDocumentMessage,
  GetRunSnapshotMessage,
  GetStatusMessage,
  ListCapabilitiesMessage,
  ListPendingInputsMessage,
  GetSubagentStatusMessage,
  ListArtifactsMessage,
  ListBackgroundTasksMessage,
  ListCheckpointsMessage,
  ListMutationLeasesMessage,
  ListMemoriesMessage,
  ListMcpServersMessage,
  ListRunsMessage,
  ListSessionsMessage,
  ListWorkflowRunsMessage,
  ListWorkflowsMessage,
  ListPlanDocumentsMessage,
  McpServerStartedMessage,
  McpServerStoppedMessage,
  McpServersListedMessage,
  MemoriesListedMessage,
  MemoryDeletedMessage,
  PendingInputCancelledMessage,
  PendingInputDispatchedMessage,
  PendingInputQueuedMessage,
  PendingInputsListedMessage,
  PingMessage,
  PongMessage,
  PreviewConversationRewindMessage,
  PatchPlanDocumentMessage,
  PreviewConversationRewindByBoundaryMessage,
  ReadRunEventsMessage,
  ReadSessionEventsMessage,
  RestoreCheckpointMessage,
  ResolveConversationRewindBoundaryMessage,
  RunEventsMessage,
  RunSnapshotMessage,
  RunTaskMessage,
  RunsListedMessage,
  DeleteScopedContextMessage,
  GetScopedContextMessage,
  ResolveScopedContextMessage,
  ScopedContextDeletedMessage,
  ScopedContextResolvedMessage,
  ScopedContextResponseMessage,
  ScopedContextUpsertedMessage,
  SendToSubagentMessage,
  SessionEventsMessage,
  SessionActionReceiptMessage,
  SessionsListedMessage,
  EnqueuePendingInputMessage,
  StartMcpServerMessage,
  StartBackgroundTaskMessage,
  StatusResponseMessage,
  StopMcpServerMessage,
  SubagentEndedMessage,
  SubagentEventMessage,
  SubagentMessageSentMessage,
  SubagentStartedMessage,
  SubagentStatusMessage,
  MutationLeasesListedMessage,
  TriggerWorkflowMessage,
  UpsertScopedContextMessage,
  UpdateWorkflowMessage,
  UpdateConfigMessage,
  WorkflowCreatedMessage,
  WorkflowDeletedMessage,
  WorkflowRunUpdatedMessage,
  WorkflowRunsListedMessage,
  WorkflowTriggeredMessage,
  WorkflowUpdatedMessage,
  WorkflowsListedMessage,
  PlanDocumentsListedMessage,
  PlanDocumentCreatedMessage,
  PlanDocumentMessage,
  PlanDocumentPatchedMessage,
  PlanDocumentDeletedMessage,
} from "../types.js";
import { isDailyTime, isValidTimeZone } from "../workflow-store.js";
import {
  DAEMON_INBOUND_MESSAGE_TYPES,
  DAEMON_OUTBOUND_MESSAGE_TYPES,
} from "./registry.js";

export type ProtocolValidationErrorCode =
  | "INVALID_MESSAGE"
  | "UNKNOWN_MESSAGE_TYPE";

export interface ProtocolValidationIssue {
  path: string;
  message: string;
}

export interface ProtocolValidationError {
  code: ProtocolValidationErrorCode;
  message: string;
  issues: ProtocolValidationIssue[];
}

export type ProtocolValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProtocolValidationError };

export const INBOUND_MESSAGE_TYPES = DAEMON_INBOUND_MESSAGE_TYPES;
export const OUTBOUND_MESSAGE_TYPES = DAEMON_OUTBOUND_MESSAGE_TYPES;

type UnknownRecord = Record<string, unknown>;
const CORRELATION_FIELDS = ["requestId", "correlationId"] as const;

const RUN_TASK_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "runId",
  "sessionId",
  "prompt",
  "mode",
  "workspaceMode",
  "cwd",
  "visibleGoal",
  "budgetDifficulty",
  "runTokenBudget",
  "maxRounds",
  "maxStalledRounds",
  "backgroundDrainTimeoutMs",
  "permissionMode",
  "workspaceRoot",
  "projectRoot",
  "projectMarkers",
  "projectFiles",
  "projectTags",
  "packageNames",
  "scopedContextConfig",
] as const;

const APPROVE_TOOL_FIELDS = ["type", ...CORRELATION_FIELDS, "toolCallId", "scope"] as const;
const DENY_TOOL_FIELDS = ["type", ...CORRELATION_FIELDS, "toolCallId"] as const;
const CANCEL_RUN_FIELDS = ["type", ...CORRELATION_FIELDS, "runId"] as const;
const EMPTY_COMMAND_FIELDS = ["type", ...CORRELATION_FIELDS] as const;
const LIST_SESSIONS_FIELDS = ["type", ...CORRELATION_FIELDS, "includeArchived", "includeDeleted"] as const;
const UPDATE_CONFIG_FIELDS = ["type", ...CORRELATION_FIELDS, "apiKey", "baseUrl", "model", "credentialMode", "endpoint", "stream"] as const;
const LIST_RUNS_FIELDS = ["type", ...CORRELATION_FIELDS, "sessionId"] as const;
const READ_SESSION_EVENTS_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "sessionId",
  "afterSequence",
  "lastEventId",
  "maxEvents",
  "cursor",
] as const;
const READ_RUN_EVENTS_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "runId",
  "afterSequence",
  "lastEventId",
  "includeSnapshot",
  "maxEvents",
  "cursor",
] as const;
const GET_RUN_SNAPSHOT_FIELDS = ["type", ...CORRELATION_FIELDS, "runId"] as const;
const CREATE_WORKFLOW_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "id",
  "name",
  "prompt",
  "cwd",
  "mode",
  "schedule",
  "enabled",
  "metadata",
] as const;
const UPDATE_WORKFLOW_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "workflowId",
  "name",
  "prompt",
  "cwd",
  "mode",
  "schedule",
  "enabled",
  "metadata",
] as const;
const DELETE_WORKFLOW_FIELDS = ["type", ...CORRELATION_FIELDS, "workflowId"] as const;
const TRIGGER_WORKFLOW_FIELDS = ["type", ...CORRELATION_FIELDS, "workflowId", "runId", "sessionId"] as const;
const LIST_WORKFLOW_RUNS_FIELDS = ["type", ...CORRELATION_FIELDS, "workflowId"] as const;
const GIT_STATUS_FIELDS = ["type", ...CORRELATION_FIELDS, "cwd"] as const;
const GIT_DIFF_FIELDS = ["type", ...CORRELATION_FIELDS, "cwd", "path", "staged"] as const;
const CREATE_PLAN_DOCUMENT_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "id",
  "title",
  "goal",
  "assumptions",
  "questions",
  "steps",
  "acceptance",
  "risks",
  "status",
  "version",
  "createdAt",
  "updatedAt",
  "metadata",
] as const;
const CREATE_REQUIREMENTS_ALIGNMENT_PLAN_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "id",
  "title",
  "goal",
  "context",
  "questions",
  "assumptions",
  "acceptance",
  "risks",
  "source",
  "metadata",
] as const;
const GET_PLAN_DOCUMENT_FIELDS = ["type", ...CORRELATION_FIELDS, "documentId"] as const;
const PATCH_PLAN_DOCUMENT_FIELDS = ["type", ...CORRELATION_FIELDS, "documentId", "patch"] as const;
const DELETE_PLAN_DOCUMENT_FIELDS = ["type", ...CORRELATION_FIELDS, "documentId"] as const;
const LIST_MUTATION_LEASES_FIELDS = ["type", ...CORRELATION_FIELDS, "cwd"] as const;
const LIST_BACKGROUND_TASKS_FIELDS = ["type", ...CORRELATION_FIELDS, "includeHistory", "state", "limit"] as const;
const START_BACKGROUND_TASK_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "command",
  "cwd",
  "workspaceRoot",
  "timeoutMs",
  "maxOutputBytes",
  "heartbeatIntervalMs",
] as const;
const CANCEL_BACKGROUND_TASK_FIELDS = ["type", ...CORRELATION_FIELDS, "taskId"] as const;
const GET_BACKGROUND_TASK_HISTORY_FIELDS = ["type", ...CORRELATION_FIELDS, "state", "limit"] as const;
const LIST_ARTIFACTS_FIELDS = ["type", ...CORRELATION_FIELDS, "sessionId"] as const;
const GET_ARTIFACT_CONTENT_FIELDS = ["type", ...CORRELATION_FIELDS, "artifactUri"] as const;
const LIST_MEMORIES_FIELDS = ["type", ...CORRELATION_FIELDS, "scope"] as const;
const DELETE_MEMORY_FIELDS = ["type", ...CORRELATION_FIELDS, "memoryId"] as const;
const LIST_CHECKPOINTS_FIELDS = ["type", ...CORRELATION_FIELDS, "runId", "sessionId"] as const;
const RESTORE_CHECKPOINT_FIELDS = ["type", ...CORRELATION_FIELDS, "checkpointId"] as const;
const GET_CHECKPOINT_DIFF_FIELDS = ["type", ...CORRELATION_FIELDS, "checkpointId"] as const;
const CONVERSATION_REWIND_BOUNDARY_REQUEST_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "sessionId",
  "userMessageId",
  "latestUserMessage",
  "mode",
] as const;
const PREVIEW_CONVERSATION_REWIND_BY_BOUNDARY_FIELDS = [
  ...CONVERSATION_REWIND_BOUNDARY_REQUEST_FIELDS,
  "restorePolicy",
  "activeSubagents",
] as const;
const CONVERSATION_REWIND_REQUEST_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "sessionId",
  "targetLeafId",
  "entries",
  "userMessageId",
  "latestUserMessage",
  "mode",
  "checkpoint",
  "restorePolicy",
  "activeSubagents",
] as const;
const APPLY_SESSION_ACTION_FIELDS = ["type", ...CORRELATION_FIELDS, "action"] as const;
const ENQUEUE_PENDING_INPUT_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "sessionId",
  "text",
  "runId",
  "mode",
  "inputId",
  "source",
  "metadata",
] as const;
const CANCEL_PENDING_INPUT_FIELDS = ["type", ...CORRELATION_FIELDS, "inputId", "sessionId", "reason"] as const;
const DISPATCH_PENDING_INPUT_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "inputId",
  "sessionId",
  "targetRunId",
] as const;
const LIST_PENDING_INPUTS_FIELDS = ["type", ...CORRELATION_FIELDS, "sessionId"] as const;
const PENDING_INPUT_RECORD_FIELDS = [
  "id",
  "sessionId",
  "runId",
  "text",
  "mode",
  "status",
  "createdAt",
  "updatedAt",
  "source",
  "metadata",
] as const;
const PENDING_INPUT_QUEUED_FIELDS = ["type", ...CORRELATION_FIELDS, "input", "event"] as const;
const PENDING_INPUT_CANCELLED_FIELDS = ["type", ...CORRELATION_FIELDS, "input", "event"] as const;
const PENDING_INPUT_DISPATCHED_FIELDS = ["type", ...CORRELATION_FIELDS, "input", "event"] as const;
const PENDING_INPUTS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "inputs", "sessionId"] as const;
const SESSION_ACTION_BASE_FIELDS = [
  "protocolVersion",
  "actionId",
  "kind",
  "sessionId",
  "requestedAt",
  "requestedBy",
  "idempotencyKey",
  "consistency",
] as const;
const SESSION_ACTION_CONSISTENCY_FIELDS = [
  "expectedSessionVersion",
  "eventLogCursor",
  "workspaceVersionId",
  "parentActionId",
] as const;
const SESSION_ACTION_RECEIPT_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "protocolVersion",
  "actionId",
  "kind",
  "sessionId",
  "status",
  "committedAt",
  "resultingSessionId",
  "resultingEventId",
  "resultingWorkspaceVersionId",
  "errorCode",
  "errorMessage",
] as const;

const DAEMON_READY_FIELDS = ["type", "port", "protocolVersion", "buildHash"] as const;
const EVENT_FIELDS = ["type", "runId", "orchestratorEventId", "sequence", "timestamp", "event"] as const;
const APPROVAL_REQUESTED_FIELDS = [
  "type",
  "runId",
  "toolCallId",
  "toolName",
  "input",
  "summary",
  "timeoutMs",
  "expiresAt",
  "remainingMs",
  "risk",
  "riskReason",
  "requiresDoubleConfirm",
  "recommendSnapshot",
  "metadata",
] as const;
const APPROVAL_RESOLVED_FIELDS = ["type", "toolCallId", "decision", "reason", "expiredAt"] as const;
const ERROR_FIELDS = ["type", ...CORRELATION_FIELDS, "code", "message", "runId"] as const;
const STATUS_RESPONSE_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "lifecycle",
  "activeRuns",
  "pendingApprovals",
  "recentApprovals",
  "providerStatus",
  "mcpStatus",
  "capabilities",
] as const;
const CAPABILITIES_RESPONSE_FIELDS = ["type", ...CORRELATION_FIELDS, "snapshot"] as const;
const CAPABILITY_SNAPSHOT_FIELDS = ["schemaVersion", "generatedAt", "capabilities"] as const;
const CAPABILITY_RECORD_FIELDS = [
  "id",
  "title",
  "state",
  "reason",
  "owner",
  "relatedMessageTypes",
  "relatedTauriCommands",
  "updatedAt",
  "diagnostics",
] as const;
const CAPABILITY_DIAGNOSTIC_FIELDS = [
  "code",
  "message",
  "severity",
  "updatedAt",
  "detail",
  "metadata",
] as const;
const LIFECYCLE_FIELDS = [
  "state",
  "startedAt",
  "updatedAt",
  "readyAt",
  "stoppingAt",
  "stoppedAt",
  "uptimeMs",
  "currentPort",
  "connectedClientCount",
  "totalClientConnectionCount",
  "totalClientDisconnectCount",
  "activeRunCount",
  "recentDisconnect",
  "recentError",
  "eventStore",
  "providerReadiness",
  "mcpReadiness",
] as const;
const CLIENT_DISCONNECT_FIELDS = [
  "clientId",
  "code",
  "reason",
  "connectedAt",
  "disconnectedAt",
  "durationMs",
] as const;
const EVENT_STORE_STATUS_FIELDS = ["status", "path", "failure"] as const;
const LIFECYCLE_DIAGNOSTIC_FIELDS = [
  "code",
  "message",
  "updatedAt",
  "source",
  "severity",
  "detail",
  "metadata",
] as const;
const ACTIVE_RUN_FIELDS = ["runId", "prompt", "status", "startedAt", "cwd"] as const;
const PENDING_APPROVAL_FIELDS = [
  "toolCallId",
  "runId",
  "toolName",
  "summary",
  "createdAt",
  "status",
  "timeoutMs",
  "expiresAt",
  "remainingMs",
  "resolvedAt",
  "expiredAt",
  "reason",
  "expiredReason",
  "risk",
  "riskReason",
  "requiresDoubleConfirm",
  "recommendSnapshot",
  "metadata",
] as const;
const PROVIDER_STATUS_FIELDS = [
  "credentialMode",
  "readiness",
  "providerId",
  "routeId",
  "baseUrl",
  "model",
  "upstreamModel",
  "endpoint",
  "stream",
  "systemPromptWireMode",
  "apiKey",
  "hasDirectApiKey",
  "apiKeySource",
  "gateway",
  "lastDiagnostic",
  "updatedAt",
] as const;
const PROVIDER_REDACTED_API_KEY_FIELDS = ["hasApiKey", "source", "last4"] as const;
const PROVIDER_GATEWAY_STATUS_FIELDS = [
  "ready",
  "credentialConfigured",
  "routeDecision",
  "code",
  "selectedRouteId",
  "selectedProviderId",
  "selectedEndpointSupport",
  "selectedStreamingSupport",
  "selectedCredentialSource",
  "lastSuccess",
  "lastFailure",
  "updatedAt",
] as const;
const PROVIDER_DIAGNOSTIC_FIELDS = [
  "code",
  "message",
  "updatedAt",
  "kind",
  "status",
  "detail",
  "metadata",
] as const;
const MCP_STATUS_FIELDS = [
  "configured",
  "readiness",
  "serverCount",
  "summary",
  "diagnostics",
  "servers",
  "updatedAt",
] as const;
const CONFIG_UPDATED_FIELDS = ["type", ...CORRELATION_FIELDS, "updatedFields"] as const;
const SUBAGENT_STARTED_FIELDS = [
  "type",
  "runId",
  "subagentId",
  "subagentRunId",
  "parentToolCallId",
  "description",
  "mode",
] as const;
const SUBAGENT_ENDED_FIELDS = [
  "type",
  "runId",
  "subagentId",
  "subagentRunId",
  "parentToolCallId",
  "status",
  "summary",
] as const;
const SUBAGENT_EVENT_FIELDS = [
  "type",
  "runId",
  "subagentId",
  "subagentRunId",
  "parentToolCallId",
  "event",
] as const;
const SESSIONS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "sessions", "summaries", "eventLog", "diagnostics"] as const;
const RUNS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "runs", "sessionId"] as const;
const SESSION_EVENTS_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "sessionId",
  "events",
  "eventLog",
  "cursorDiagnostic",
  "diagnostics",
  "nextAfterSequence",
  "hasMore",
  "nextCursor",
  "afterSequence",
  "lastEventId",
] as const;
const RUN_EVENTS_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "runId",
  "events",
  "eventLog",
  "cursorDiagnostic",
  "diagnostics",
  "nextAfterSequence",
  "hasMore",
  "nextCursor",
  "afterSequence",
  "lastEventId",
  "snapshot",
] as const;
const RUN_SNAPSHOT_FIELDS = ["type", ...CORRELATION_FIELDS, "runId", "snapshot"] as const;
const WORKFLOWS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "workflows"] as const;
const WORKFLOW_CREATED_FIELDS = ["type", ...CORRELATION_FIELDS, "workflow"] as const;
const WORKFLOW_UPDATED_FIELDS = ["type", ...CORRELATION_FIELDS, "workflow"] as const;
const WORKFLOW_DELETED_FIELDS = ["type", ...CORRELATION_FIELDS, "workflowId"] as const;
const WORKFLOW_TRIGGERED_FIELDS = ["type", ...CORRELATION_FIELDS, "accepted", "runId", "workflowRunId", "run"] as const;
const WORKFLOW_RUN_UPDATED_FIELDS = ["type", ...CORRELATION_FIELDS, "runId", "workflowRunId", "workflowId", "run"] as const;
const WORKFLOW_RUNS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "runs", "workflowId"] as const;
const GIT_STATUS_RESPONSE_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "cwd",
  "found",
  "repositoryRoot",
  "gitDir",
  "head",
  "branch",
  "clean",
  "files",
  "stagedCount",
  "unstagedCount",
  "untrackedCount",
  "conflictedCount",
  "reason",
] as const;
const GIT_STATUS_FILE_FIELDS = [
  "path",
  "status",
  "index",
  "worktree",
  "staged",
  "unstaged",
  "untracked",
  "conflicted",
  "originalPath",
] as const;
const GIT_DIFF_RESPONSE_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "cwd",
  "repositoryRoot",
  "path",
  "staged",
  "unified",
  "stat",
  "files",
] as const;
const PLAN_DOCUMENTS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "documents"] as const;
const PLAN_DOCUMENT_MESSAGE_FIELDS = ["type", ...CORRELATION_FIELDS, "document"] as const;
const PLAN_DOCUMENT_DELETED_FIELDS = ["type", ...CORRELATION_FIELDS, "documentId"] as const;
const MUTATION_LEASES_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "leases"] as const;
const BACKGROUND_TASKS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "tasks", "diagnostics"] as const;
const BACKGROUND_TASK_SINGLE_FIELDS = ["type", ...CORRELATION_FIELDS, "task", "diagnostics"] as const;
const ARTIFACTS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "artifacts"] as const;
const ARTIFACT_CONTENT_FIELDS = ["type", ...CORRELATION_FIELDS, "artifactUri", "content", "mimeType"] as const;
const MEMORIES_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "memories"] as const;
const MEMORY_DELETED_FIELDS = ["type", ...CORRELATION_FIELDS, "memoryId"] as const;
const CHECKPOINTS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "checkpoints"] as const;
const CHECKPOINT_DIFF_FIELDS = ["type", ...CORRELATION_FIELDS, "checkpointId", "files"] as const;
const CHECKPOINT_RESTORED_FIELDS = ["type", ...CORRELATION_FIELDS, "checkpointId", "runId"] as const;
const CONVERSATION_REWIND_BOUNDARY_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "status",
  "sessionId",
  "userMessageId",
  "latestUserMessage",
  "mode",
  "boundary",
  "checkpoint",
  "target",
  "missingFacts",
  "diagnostics",
  "plan",
  "runtimeTargetLeafId",
] as const;
const CONVERSATION_REWIND_PREVIEW_FIELDS = ["type", ...CORRELATION_FIELDS, "sessionId", "plan"] as const;
const CONVERSATION_REWIND_APPLIED_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "sessionId",
  "plan",
  "stepResults",
] as const;
const CONVERSATION_REWIND_STEP_RESULT_FIELDS = ["type", "status", "code", "message", "affectedIds", "metadata"] as const;
const SESSION_TREE_ENTRY_FIELDS = [
  "type",
  "id",
  "parentId",
  "createdAt",
  "payload",
  "summary",
  "abandonedLeafId",
  "details",
] as const;
const REWIND_CHECKPOINT_FIELDS = ["source", "checkpointId", "manifestPath", "checkpoint", "cleanUntracked"] as const;
const REWIND_ACTIVE_SUBAGENT_FIELDS = ["parentRunId", "subagentRunId", "subagentId"] as const;
const REWIND_BOUNDARY_RECORD_FIELDS = [
  "sessionId",
  "runId",
  "userMessageId",
  "sessionTreeLeafIdBefore",
  "sessionTreeLeafIdAfter",
  "runtimeLeafIdBefore",
  "runtimeLeafIdAfter",
  "eventSequence",
  "workspaceRoot",
  "checkpointId",
  "checkpointRef",
  "checkpointSource",
  "changedPaths",
  "createdAt",
  "metadata",
] as const;
const REWIND_CHECKPOINT_RECORD_FIELDS = [
  "sessionId",
  "runId",
  "userMessageId",
  "toolCall",
  "checkpointId",
  "checkpointRef",
  "workspaceRoot",
  "changedPaths",
  "source",
  "createdAt",
  "metadata",
] as const;
const REWIND_CHECKPOINT_TOOL_CALL_FIELDS = ["id", "toolName", "actor", "sessionId", "targetSummary"] as const;
const REWIND_TARGET_FACTS_FIELDS = [
  "sessionId",
  "runId",
  "userMessageId",
  "mode",
  "eventSequence",
  "workspaceRoot",
  "changedPaths",
  "createdAt",
  "sessionTreeTargetLeafId",
  "runtimeTargetLeafId",
  "checkpoint",
  "missingFacts",
  "metadata",
] as const;
const REWIND_TARGET_CHECKPOINT_FACTS_FIELDS = [
  "checkpointId",
  "checkpointRef",
  "checkpointSource",
  "workspaceRoot",
  "changedPaths",
  "createdAt",
] as const;
const REWIND_BOUNDARY_DIAGNOSTIC_FIELDS = ["code", "fact", "message", "blocked", "metadata"] as const;
const REWIND_PLAN_FIELDS = [
  "sessionId",
  "fromLeafId",
  "targetLeafId",
  "targetPath",
  "entryProjection",
  "runCancellations",
  "approvalClearances",
  "workspaceRestore",
  "steps",
] as const;
const REWIND_ENTRY_PROJECTION_FIELDS = [
  "currentPath",
  "targetPath",
  "commonAncestorId",
  "retainedEntryIds",
  "hiddenEntryIds",
  "hiddenCurrentPathEntryIds",
  "hiddenBranchEntryIds",
] as const;
const REWIND_RUN_CANCELLATION_FIELDS = ["runId", "reason", "role"] as const;
const REWIND_APPROVAL_CLEARANCE_FIELDS = ["toolCallId", "runId", "reason"] as const;
const REWIND_WORKSPACE_RESTORE_FIELDS = [
  "required",
  "source",
  "checkpointId",
  "checkpoint",
  "manifestPath",
  "cleanUntracked",
] as const;
const REWIND_STEP_FIELDS = ["type", "runs", "approvals", "restore", "sessionId", "fromLeafId", "toLeafId"] as const;
const MUTATION_LEASE_FIELDS = [
  "token",
  "scope",
  "owner",
  "createdAt",
  "expiresAt",
  "ttlMs",
] as const;
const MUTATION_LEASE_OWNER_FIELDS = [
  "runId",
  "sessionId",
  "toolCallId",
  "toolName",
  "cwd",
  "targetSummary",
] as const;
const BACKGROUND_TASK_FIELDS = [
  "id",
  "kind",
  "title",
  "state",
  "command",
  "cwd",
  "startedAt",
  "updatedAt",
  "finishedAt",
  "durationMs",
  "timeoutMs",
  "exitCode",
  "signal",
  "timedOut",
  "cancelled",
  "truncated",
  "stdoutBytes",
  "stderrBytes",
  "outputPreview",
  "diagnostics",
] as const;
const BACKGROUND_TASK_DIAGNOSTIC_FIELDS = [
  "code",
  "message",
  "severity",
  "updatedAt",
  "detail",
  "metadata",
] as const;
const ARTIFACT_RECORD_FIELDS = ["uri", "type", "name", "size", "createdAt", "sessionId", "runId"] as const;
const MEMORY_RECORD_FIELDS = ["id", "key", "value", "scope", "createdAt", "updatedAt"] as const;
const CHECKPOINT_RECORD_FIELDS = ["id", "runId", "sessionId", "label", "createdAt", "messageCount"] as const;
const CHANGED_FILE_RECORD_FIELDS = ["path", "status", "addedLines", "removedLines"] as const;
const SEND_TO_SUBAGENT_FIELDS = ["type", ...CORRELATION_FIELDS, "subagentRunId", "message"] as const;
const GET_SUBAGENT_STATUS_FIELDS = ["type", ...CORRELATION_FIELDS, "subagentRunId"] as const;
const MCP_SERVER_CONTROL_FIELDS = ["type", ...CORRELATION_FIELDS, "serverId"] as const;
const MCP_SERVERS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "servers"] as const;
const MCP_SERVER_STARTED_FIELDS = ["type", ...CORRELATION_FIELDS, "serverId", "state"] as const;
const MCP_SERVER_STOPPED_FIELDS = ["type", ...CORRELATION_FIELDS, "serverId", "state"] as const;
const GET_SCOPED_CONTEXT_FIELDS = ["type", ...CORRELATION_FIELDS, "scope", "kind"] as const;
const UPSERT_SCOPED_CONTEXT_FIELDS = ["type", ...CORRELATION_FIELDS, "record"] as const;
const DELETE_SCOPED_CONTEXT_FIELDS = ["type", ...CORRELATION_FIELDS, "recordId"] as const;
const RESOLVE_SCOPED_CONTEXT_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "cwd",
  "workspaceRoot",
  "projectRoot",
  "projectMarkers",
  "projectFiles",
  "projectTags",
  "packageNames",
  "userEnabledIds",
  "userDisabledIds",
  "scopedContextConfig",
] as const;
const SCOPED_CONTEXT_RUNTIME_CONFIG_FIELDS = [
  "userEnabledIds",
  "userDisabledIds",
  "includeRecommendationHints",
  "includeAncestorContextFiles",
  "includeProjectSkillDirs",
  "includeWorkspaceSkillDirs",
  "includeGlobalSkillDirs",
  "globalSkillDirs",
  "workspaceSkillDirs",
  "projectSkillDirs",
  "globalRuleFiles",
  "workspaceRuleFiles",
  "projectRuleFiles",
  "globalRuleDirs",
  "workspaceRuleDirs",
  "projectRuleDirs",
] as const;
const MCP_SERVER_RECORD_FIELDS = [
  "id",
  "name",
  "state",
  "transport",
  "cachedToolCount",
  "lastError",
  "startedAt",
] as const;
const SUBAGENT_MESSAGE_SENT_FIELDS = ["type", ...CORRELATION_FIELDS, "subagentRunId", "accepted"] as const;
const SUBAGENT_STATUS_FIELDS = ["type", ...CORRELATION_FIELDS, "subagentRunId", "status", "progress", "latestError"] as const;
const SCOPED_CONTEXT_RESPONSE_FIELDS = ["type", ...CORRELATION_FIELDS, "status", "records", "diagnostic"] as const;
const SCOPED_CONTEXT_UPSERTED_FIELDS = ["type", ...CORRELATION_FIELDS, "status", "record", "persisted", "diagnostic"] as const;
const SCOPED_CONTEXT_DELETED_FIELDS = ["type", ...CORRELATION_FIELDS, "status", "recordId", "deleted", "diagnostic"] as const;
const SCOPED_CONTEXT_RESOLVED_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "status",
  "stableContext",
  "recommended",
  "items",
  "diagnostics",
  "stableContextHash",
  "storeRecordCount",
  "resourceRecordCount",
  "resourceDiagnostics",
  "storeDiagnostic",
] as const;
const SCOPED_CONTEXT_RECORD_FIELDS = [
  "id",
  "kind",
  "title",
  "content",
  "description",
  "scope",
  "activation",
  "appliesTo",
  "tags",
  "source",
  "sourceMetadata",
  "order",
  "updatedAt",
] as const;
const SCOPED_CONTEXT_SOURCE_FIELDS = ["type", "path", "label"] as const;
const SCOPED_CONTEXT_DIAGNOSTIC_FIELDS = ["code", "message", "updatedAt", "path", "detail"] as const;
const SCOPED_CONTEXT_CANDIDATE_FIELDS = [
  "id",
  "kind",
  "title",
  "description",
  "scope",
  "activation",
  "appliesTo",
  "tags",
  "source",
  "reason",
] as const;
const SCOPED_CONTEXT_ITEM_FIELDS = [...SCOPED_CONTEXT_CANDIDATE_FIELDS, "status"] as const;
const SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_FIELDS = ["severity", "id", "code", "message"] as const;
const SCOPED_CONTEXT_RESOURCE_DIAGNOSTIC_FIELDS = ["severity", "path", "message"] as const;
const PROMPT_CONTEXT_BLOCK_FIELDS = ["id", "kind", "label", "content"] as const;
const WORKFLOW_FIELDS = [
  "id",
  "name",
  "prompt",
  "cwd",
  "mode",
  "schedule",
  "enabled",
  "createdAt",
  "updatedAt",
  "metadata",
] as const;
const WORKFLOW_RUN_FIELDS = [
  "workflowId",
  "runId",
  "sessionId",
  "scheduledFor",
  "startedAt",
  "status",
  "error",
] as const;
const PLAN_DOCUMENT_SUMMARY_FIELDS = [
  "id",
  "title",
  "goal",
  "status",
  "version",
  "createdAt",
  "updatedAt",
  "steps",
  "questions",
  "assumptions",
  "acceptance",
  "risks",
] as const;
const TASK_SNAPSHOT_FIELDS = [
  "runId",
  "sessionId",
  "status",
  "title",
  "messages",
  "latestError",
  "approval",
  "pendingToolCalls",
  "backgroundTasks",
  "progress",
  "usage",
  "cache",
  "updatedAt",
  "progressLabel",
  "currentRun",
] as const;
const TASK_MESSAGE_FIELDS = ["id", "role", "content", "createdAt", "toolCalls"] as const;
const TASK_TOOL_CALL_FIELDS = [
  "id",
  "name",
  "input",
  "status",
  "summary",
  "startedAt",
  "updatedAt",
  "output",
  "approvalMetadata",
] as const;
const TASK_APPROVAL_FIELDS = [
  "toolCallId",
  "toolName",
  "input",
  "summary",
  "requestedAt",
  "status",
  "risk",
  "riskReason",
  "requiresDoubleConfirm",
  "recommendSnapshot",
  "metadata",
] as const;
const TASK_PROGRESS_FIELDS = [
  "label",
  "eventCount",
  "turnCount",
  "textDeltaCount",
  "toolCallCount",
  "completedToolCallCount",
  "pendingToolCallCount",
  "approvalPending",
  "updatedAt",
] as const;
const TASK_USAGE_FIELDS = [
  "sampleCount",
  "promptTokens",
  "completionTokens",
  "totalTokens",
  "reasoningTokens",
] as const;
const TASK_CACHE_FIELDS = [
  "sampleCount",
  "promptTokens",
  "readTokens",
  "writeTokens",
  "missTokens",
  "hitRatio",
  "writeRatio",
  "stablePrefixHash",
  "cacheKey",
  "cacheStrategy",
] as const;
const TASK_BACKGROUND_TASK_FIELDS = [
  "id",
  "kind",
  "title",
  "state",
  "command",
  "cwd",
  "startedAt",
  "updatedAt",
  "finishedAt",
  "durationMs",
  "exitCode",
  "signal",
  "outputPreview",
] as const;
const TASK_CURRENT_RUN_FIELDS = ["id", "sessionId", "cwd", "createdAt", "updatedAt", "startedAt", "finishedAt", "metadata"] as const;
const SESSION_RECORD_FIELDS = [
  "id",
  "cwd",
  "createdAt",
  "updatedAt",
  "status",
  "currentLeafId",
  "metadata",
] as const;
const RUN_RECORD_FIELDS = [
  "id",
  "sessionId",
  "cwd",
  "status",
  "createdAt",
  "updatedAt",
  "startedAt",
  "finishedAt",
  "outcome",
  "reason",
  "outcomeDetail",
  "error",
  "kind",
  "goal",
  "lastEventId",
  "metadata",
] as const;
const ORCHESTRATOR_EVENT_FIELDS = [
  "protocolVersion",
  "id",
  "sequence",
  "type",
  "sessionId",
  "runId",
  "timestamp",
  "payload",
] as const;
const SESSION_STATUSES = ["open", "closed", "archived"] as const;
const PENDING_INPUT_MODES = ["after-current-run", "steer"] as const;
const PENDING_INPUT_STATUSES = ["pending", "cancelled", "dispatched"] as const;
const PENDING_INPUT_SOURCES = ["workbench", "daemon", "automation"] as const;
const RUN_STATUSES = [
  "queued",
  "running",
  "awaiting-approval",
  "cancelling",
  "cancelled",
  "completed",
  "failed",
] as const;
const WORKFLOW_RUN_STATUSES = ["running", "awaiting-approval", "completed", "failed", "cancelled"] as const;
const BACKGROUND_TASK_STATES = ["running", "succeeded", "failed", "cancelled", "timed-out"] as const;
const WORKFLOW_SCHEDULE_TYPES = ["manual", "daily", "intervalMinutes"] as const;
const PROVIDER_CREDENTIAL_MODES = ["direct", "auto"] as const;
const PROVIDER_ENDPOINTS = ["auto", "responses", "chat-completions"] as const;
const SYSTEM_PROMPT_WIRE_MODES = ["native-system-role", "user-prefix"] as const;
const PROVIDER_READINESS_STATUSES = [
  "ready",
  "missing",
  "login-required",
  "insufficient-quota",
  "gateway-unavailable",
  "credential-unavailable",
  "invalid-response",
  "unknown",
] as const;
const PROVIDER_API_KEY_SOURCES = ["default", "env", "runtime-update", "user-config", "workspace-config", "unset", "unknown"] as const;
const DAEMON_LIFECYCLE_STATES = ["starting", "ready", "stopping", "stopped", "degraded"] as const;
const LIFECYCLE_DIAGNOSTIC_SOURCES = ["daemon", "websocket", "client", "event-store", "provider", "mcp"] as const;
const LIFECYCLE_DIAGNOSTIC_SEVERITIES = ["warning", "error"] as const;
const EVENT_STORE_STATUSES = ["ok", "failed"] as const;
const MCP_READINESS_STATUSES = ["ready", "degraded", "starting", "stopped", "unknown"] as const;
const CAPABILITY_STATES = ["implemented", "experimental", "unsupported", "degraded", "backend-not-wired"] as const;
const CAPABILITY_OWNERS = ["agent-daemon", "agent-runtime", "agent-orchestrator", "workbench", "tauri"] as const;
const CAPABILITY_DIAGNOSTIC_SEVERITIES = ["info", "warning", "error"] as const;
const SCOPED_CONTEXT_KINDS = ["rule", "skill"] as const;
const SCOPED_CONTEXT_SCOPES = ["global", "project", "workspace"] as const;
const SCOPED_CONTEXT_ACTIVATIONS = ["enabled", "recommended", "disabled"] as const;
const SCOPED_CONTEXT_STORE_STATUSES = ["ok", "degraded"] as const;
const SCOPED_CONTEXT_SOURCE_TYPES = [
  "global-rule",
  "project-rule",
  "workspace-rule",
  "skill-file",
  "user",
  "system",
] as const;
const SCOPED_CONTEXT_ITEM_STATUSES = ["active", "recommended", "disabled", "inapplicable"] as const;
const SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_SEVERITIES = ["info", "warning"] as const;
const SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_CODES = [
  "disabled",
  "scope-mismatch",
  "applies-to-mismatch",
  "empty-content",
] as const;
const PROMPT_CONTEXT_BLOCK_KINDS = [
  "project-profile",
  "runtime-profile",
  "skills-hook",
  "memory-hook",
  "plan-hook",
  "custom-stable",
  "custom-volatile",
] as const;
const RUN_KINDS = ["task", "goal"] as const;
const APPROVAL_PROTOCOL_STATUSES = ["pending", "approved", "denied", "expired"] as const;
const GOAL_RUN_STATUSES = ["queued", "running", "completed", "blocked", "cancelled", "failed"] as const;
const GOAL_STOPPED_REASONS = ["complete", "blocked", "max-rounds", "stalled", "cancelled", "error"] as const;
const GOAL_CONTINUATION_ACTIONS = ["continue", "complete", "block"] as const;
const GOAL_STATE_FIELDS = [
  "status",
  "visibleGoal",
  "maxRounds",
  "maxStalledRounds",
  "currentRound",
  "completedRounds",
  "stalledRounds",
  "stoppedReason",
  "lastProgressSignature",
  "lastDecision",
] as const;
const GOAL_DECISION_FIELDS = ["action", "reason", "prompt", "progressSignature", "detail"] as const;
const ORCHESTRATOR_EVENT_TYPES = [
  "session-created",
  "conversation-rewind-audit",
  "session-leaf-moved",
  "pending-input-created",
  "pending-input-cancelled",
  "pending-input-dispatched",
  "run-queued",
  "run-started",
  "goal-round-started",
  "goal-round-completed",
  "goal-continuation-decided",
  "runtime-event",
  "run-cancel-requested",
  "run-cancelled",
  "run-completed",
  "run-failed",
] as const;

export function validateInboundMessage(
  value: unknown
): ProtocolValidationResult<DaemonInboundMessage> {
  const base = validateMessageBase(value, INBOUND_MESSAGE_TYPES);
  if (!base.ok) return base;

  switch (base.value.type) {
    case "hello":
      return { ok: true, value: base.value as unknown as DaemonInboundMessage };
    case "run-task":
      return withMessageCorrelation(base.value, validateRunTaskMessage(base.value));
    case "approve-tool":
      return withMessageCorrelation(base.value, validateApproveToolMessage(base.value));
    case "deny-tool":
      return withMessageCorrelation(base.value, validateDenyToolMessage(base.value));
    case "cancel-run":
      return withMessageCorrelation(base.value, validateCancelRunMessage(base.value));
    case "ping":
      return withMessageCorrelation(base.value, validatePingMessage(base.value));
    case "get-status":
      return withMessageCorrelation(base.value, validateGetStatusMessage(base.value));
    case "list-capabilities":
      return withMessageCorrelation(base.value, validateListCapabilitiesMessage(base.value));
    case "update-config":
      return withMessageCorrelation(base.value, validateUpdateConfigMessage(base.value));
    case "list-sessions":
      return withMessageCorrelation(base.value, validateListSessionsMessage(base.value));
    case "list-runs":
      return withMessageCorrelation(base.value, validateListRunsMessage(base.value));
    case "read-session-events":
      return withMessageCorrelation(base.value, validateReadSessionEventsMessage(base.value));
    case "read-run-events":
      return withMessageCorrelation(base.value, validateReadRunEventsMessage(base.value));
    case "get-run-snapshot":
      return withMessageCorrelation(base.value, validateGetRunSnapshotMessage(base.value));
    case "enqueue-pending-input":
      return withMessageCorrelation(base.value, validateEnqueuePendingInputMessage(base.value));
    case "cancel-pending-input":
      return withMessageCorrelation(base.value, validateCancelPendingInputMessage(base.value));
    case "dispatch-pending-input":
      return withMessageCorrelation(base.value, validateDispatchPendingInputMessage(base.value));
    case "list-pending-inputs":
      return withMessageCorrelation(base.value, validateListPendingInputsMessage(base.value));
    case "list-workflows":
      return withMessageCorrelation(base.value, validateListWorkflowsMessage(base.value));
    case "create-workflow":
      return withMessageCorrelation(base.value, validateCreateWorkflowMessage(base.value));
    case "update-workflow":
      return withMessageCorrelation(base.value, validateUpdateWorkflowMessage(base.value));
    case "delete-workflow":
      return withMessageCorrelation(base.value, validateDeleteWorkflowMessage(base.value));
    case "trigger-workflow":
      return withMessageCorrelation(base.value, validateTriggerWorkflowMessage(base.value));
    case "list-workflow-runs":
      return withMessageCorrelation(base.value, validateListWorkflowRunsMessage(base.value));
    case "git-status":
      return withMessageCorrelation(base.value, validateGitStatusMessage(base.value));
    case "git-diff":
      return withMessageCorrelation(base.value, validateGitDiffMessage(base.value));
    case "list-plan-documents":
      return withMessageCorrelation(base.value, validateListPlanDocumentsMessage(base.value));
    case "create-plan-document":
      return withMessageCorrelation(base.value, validateCreatePlanDocumentMessage(base.value));
    case "create-requirements-alignment-plan":
      return withMessageCorrelation(base.value, validateCreateRequirementsAlignmentPlanMessage(base.value));
    case "get-plan-document":
      return withMessageCorrelation(base.value, validateGetPlanDocumentMessage(base.value));
    case "patch-plan-document":
      return withMessageCorrelation(base.value, validatePatchPlanDocumentMessage(base.value));
    case "delete-plan-document":
      return withMessageCorrelation(base.value, validateDeletePlanDocumentMessage(base.value));
    case "list-mutation-leases":
      return withMessageCorrelation(base.value, validateListMutationLeasesMessage(base.value));
    case "list-background-tasks":
      return withMessageCorrelation(base.value, validateListBackgroundTasksMessage(base.value));
    case "start-background-task":
      return withMessageCorrelation(base.value, validateStartBackgroundTaskMessage(base.value));
    case "cancel-background-task":
      return withMessageCorrelation(base.value, validateCancelBackgroundTaskMessage(base.value));
    case "get-background-task-history":
      return withMessageCorrelation(base.value, validateGetBackgroundTaskHistoryMessage(base.value));
    case "list-artifacts":
      return withMessageCorrelation(base.value, validateListArtifactsMessage(base.value));
    case "get-artifact-content":
      return withMessageCorrelation(base.value, validateGetArtifactContentMessage(base.value));
    case "list-memories":
      return withMessageCorrelation(base.value, validateListMemoriesMessage(base.value));
    case "delete-memory":
      return withMessageCorrelation(base.value, validateDeleteMemoryMessage(base.value));
    case "list-checkpoints":
      return withMessageCorrelation(base.value, validateListCheckpointsMessage(base.value));
    case "restore-checkpoint":
      return withMessageCorrelation(base.value, validateRestoreCheckpointMessage(base.value));
    case "get-checkpoint-diff":
      return withMessageCorrelation(base.value, validateGetCheckpointDiffMessage(base.value));
    case "resolve-conversation-rewind-boundary":
      return withMessageCorrelation(base.value, validateResolveConversationRewindBoundaryMessage(base.value));
    case "preview-conversation-rewind":
      return withMessageCorrelation(base.value, validatePreviewConversationRewindMessage(base.value));
    case "preview-conversation-rewind-by-boundary":
      return withMessageCorrelation(base.value, validatePreviewConversationRewindByBoundaryMessage(base.value));
    case "apply-conversation-rewind":
      return withMessageCorrelation(base.value, validateApplyConversationRewindMessage(base.value));
    case "apply-session-action":
      return withMessageCorrelation(base.value, validateApplySessionActionMessage(base.value));
    case "send-to-subagent":
      return withMessageCorrelation(base.value, validateSendToSubagentMessage(base.value));
    case "get-subagent-status":
      return withMessageCorrelation(base.value, validateGetSubagentStatusMessage(base.value));
    case "start-mcp-server":
      return withMessageCorrelation(base.value, validateStartMcpServerMessage(base.value));
    case "stop-mcp-server":
      return withMessageCorrelation(base.value, validateStopMcpServerMessage(base.value));
    case "list-mcp-servers":
      return withMessageCorrelation(base.value, validateListMcpServersMessage(base.value));
    case "get-scoped-context":
      return withMessageCorrelation(base.value, validateGetScopedContextMessage(base.value));
    case "upsert-scoped-context":
      return withMessageCorrelation(base.value, validateUpsertScopedContextMessage(base.value));
    case "delete-scoped-context":
      return withMessageCorrelation(base.value, validateDeleteScopedContextMessage(base.value));
    case "resolve-scoped-context":
      return withMessageCorrelation(base.value, validateResolveScopedContextMessage(base.value));
  }
  return { ok: false, error: { code: "UNKNOWN_MESSAGE_TYPE", message: `Unhandled message type: ${base.value.type}`, issues: [] } };
}

export function validateOutboundMessage(
  value: unknown
): ProtocolValidationResult<DaemonOutboundMessage> {
  const base = validateMessageBase(value, OUTBOUND_MESSAGE_TYPES);
  if (!base.ok) return base;

  switch (base.value.type) {
    case "daemon-ready":
      return withMessageCorrelation(base.value, validateDaemonReadyMessage(base.value));
    case "event":
      return withMessageCorrelation(base.value, validateEventMessage(base.value));
    case "approval-requested":
      return withMessageCorrelation(base.value, validateApprovalRequestedMessage(base.value));
    case "approval-resolved":
      return withMessageCorrelation(base.value, validateApprovalResolvedMessage(base.value));
    case "error":
      return withMessageCorrelation(base.value, validateErrorMessage(base.value));
    case "pong":
      return withMessageCorrelation(base.value, validatePongMessage(base.value));
    case "status-response":
      return withMessageCorrelation(base.value, validateStatusResponseMessage(base.value));
    case "capabilities-response":
      return withMessageCorrelation(base.value, validateCapabilitiesResponseMessage(base.value));
    case "config-updated":
      return withMessageCorrelation(base.value, validateConfigUpdatedMessage(base.value));
    case "subagent-started":
      return withMessageCorrelation(base.value, validateSubagentStartedMessage(base.value));
    case "subagent-ended":
      return withMessageCorrelation(base.value, validateSubagentEndedMessage(base.value));
    case "subagent-event":
      return withMessageCorrelation(base.value, validateSubagentEventMessage(base.value));
    case "sessions-listed":
      return withMessageCorrelation(base.value, validateSessionsListedMessage(base.value));
    case "runs-listed":
      return withMessageCorrelation(base.value, validateRunsListedMessage(base.value));
    case "session-events":
      return withMessageCorrelation(base.value, validateSessionEventsMessage(base.value));
    case "run-events":
      return withMessageCorrelation(base.value, validateRunEventsMessage(base.value));
    case "run-snapshot":
      return withMessageCorrelation(base.value, validateRunSnapshotMessage(base.value));
    case "pending-input-queued":
      return withMessageCorrelation(base.value, validatePendingInputQueuedMessage(base.value));
    case "pending-input-cancelled":
      return withMessageCorrelation(base.value, validatePendingInputCancelledMessage(base.value));
    case "pending-input-dispatched":
      return withMessageCorrelation(base.value, validatePendingInputDispatchedMessage(base.value));
    case "pending-inputs-listed":
      return withMessageCorrelation(base.value, validatePendingInputsListedMessage(base.value));
    case "workflows-listed":
      return withMessageCorrelation(base.value, validateWorkflowsListedMessage(base.value));
    case "workflow-created":
      return withMessageCorrelation(base.value, validateWorkflowCreatedMessage(base.value));
    case "workflow-updated":
      return withMessageCorrelation(base.value, validateWorkflowUpdatedMessage(base.value));
    case "workflow-deleted":
      return withMessageCorrelation(base.value, validateWorkflowDeletedMessage(base.value));
    case "workflow-triggered":
      return withMessageCorrelation(base.value, validateWorkflowTriggeredMessage(base.value));
    case "workflow-run-updated":
      return withMessageCorrelation(base.value, validateWorkflowRunUpdatedMessage(base.value));
    case "workflow-runs-listed":
      return withMessageCorrelation(base.value, validateWorkflowRunsListedMessage(base.value));
    case "git-status-response":
      return withMessageCorrelation(base.value, validateGitStatusResponseMessage(base.value));
    case "git-diff-response":
      return withMessageCorrelation(base.value, validateGitDiffResponseMessage(base.value));
    case "plan-documents-listed":
      return withMessageCorrelation(base.value, validatePlanDocumentsListedMessage(base.value));
    case "plan-document-created":
      return withMessageCorrelation(base.value, validatePlanDocumentCreatedMessage(base.value));
    case "plan-document":
      return withMessageCorrelation(base.value, validatePlanDocumentMessage(base.value));
    case "plan-document-patched":
      return withMessageCorrelation(base.value, validatePlanDocumentPatchedMessage(base.value));
    case "plan-document-deleted":
      return withMessageCorrelation(base.value, validatePlanDocumentDeletedMessage(base.value));
    case "mutation-leases-listed":
      return withMessageCorrelation(base.value, validateMutationLeasesListedMessage(base.value));
    case "background-tasks-listed":
      return withMessageCorrelation(base.value, validateBackgroundTasksListedMessage(base.value));
    case "background-task-started":
      return withMessageCorrelation(base.value, validateBackgroundTaskStartedMessage(base.value));
    case "background-task-cancelled":
      return withMessageCorrelation(base.value, validateBackgroundTaskCancelledMessage(base.value));
    case "background-task-history":
      return withMessageCorrelation(base.value, validateBackgroundTaskHistoryMessage(base.value));
    case "artifacts-listed":
      return withMessageCorrelation(base.value, validateArtifactsListedMessage(base.value));
    case "artifact-content":
      return withMessageCorrelation(base.value, validateArtifactContentMessage(base.value));
    case "memories-listed":
      return withMessageCorrelation(base.value, validateMemoriesListedMessage(base.value));
    case "memory-deleted":
      return withMessageCorrelation(base.value, validateMemoryDeletedMessage(base.value));
    case "checkpoints-listed":
      return withMessageCorrelation(base.value, validateCheckpointsListedMessage(base.value));
    case "checkpoint-diff":
      return withMessageCorrelation(base.value, validateCheckpointDiffMessage(base.value));
    case "checkpoint-restored":
      return withMessageCorrelation(base.value, validateCheckpointRestoredMessage(base.value));
    case "conversation-rewind-boundary":
      return withMessageCorrelation(base.value, validateConversationRewindBoundaryMessage(base.value));
    case "conversation-rewind-preview":
      return withMessageCorrelation(base.value, validateConversationRewindPreviewMessage(base.value));
    case "conversation-rewind-applied":
      return withMessageCorrelation(base.value, validateConversationRewindAppliedMessage(base.value));
    case "session-action-receipt":
      return withMessageCorrelation(base.value, validateSessionActionReceiptMessage(base.value));
    case "subagent-message-sent":
      return withMessageCorrelation(base.value, validateSubagentMessageSentMessage(base.value));
    case "subagent-status":
      return withMessageCorrelation(base.value, validateSubagentStatusMessage(base.value));
    case "mcp-servers-listed":
      return withMessageCorrelation(base.value, validateMcpServersListedMessage(base.value));
    case "mcp-server-started":
      return withMessageCorrelation(base.value, validateMcpServerStartedMessage(base.value));
    case "mcp-server-stopped":
      return withMessageCorrelation(base.value, validateMcpServerStoppedMessage(base.value));
    case "scoped-context-response":
      return withMessageCorrelation(base.value, validateScopedContextResponseMessage(base.value));
    case "scoped-context-upserted":
      return withMessageCorrelation(base.value, validateScopedContextUpsertedMessage(base.value));
    case "scoped-context-deleted":
      return withMessageCorrelation(base.value, validateScopedContextDeletedMessage(base.value));
    case "welcome":
      return { ok: true, value: base.value as unknown as DaemonOutboundMessage };
    case "scoped-context-resolved":
      return withMessageCorrelation(base.value, validateScopedContextResolvedMessage(base.value));
  }
  return { ok: false, error: { code: "UNKNOWN_MESSAGE_TYPE", message: `Unhandled outbound message type: ${base.value.type}`, issues: [] } };
}

export function encodeOutboundMessage(
  message: DaemonOutboundMessage
): ProtocolValidationResult<string> {
  let payload: string;

  try {
    payload = JSON.stringify(message);
  } catch (error) {
    return invalid("Outbound message is not JSON serializable", [
      {
        path: "$",
        message: (error as Error).message,
      },
    ]);
  }

  if (payload === undefined) {
    return invalid("Outbound message is not JSON serializable", [
      { path: "$", message: "JSON.stringify returned undefined" },
    ]);
  }

  const validation = validateOutboundMessage(JSON.parse(payload));
  if (!validation.ok) return validation;

  return ok(payload);
}

export function formatProtocolValidationError(
  error: ProtocolValidationError
): string {
  const issueSummary = error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("; ");

  if (!issueSummary) return error.message;

  const suffix = error.issues.length > 3 ? " ..." : "";
  return `${error.message}: ${issueSummary}${suffix}`;
}

export function validateRunTaskMessage(
  input: UnknownRecord
): ProtocolValidationResult<RunTaskMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, RUN_TASK_FIELDS, issues);

  const runId = optionalString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });
  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });
  const prompt = requiredString(input, "prompt", "$.prompt", issues, {
    nonEmpty: true,
  });
  const mode = optionalString(input, "mode", "$.mode", issues);
  const workspaceMode = optionalEnum(
    input,
    "workspaceMode",
    "$.workspaceMode",
    ["project", "none"],
    issues
  );
  const cwd = optionalString(input, "cwd", "$.cwd", issues, {
    nonEmpty: true,
  });
  const visibleGoal = optionalString(input, "visibleGoal", "$.visibleGoal", issues, {
    nonEmpty: true,
  });
  const budgetDifficulty = optionalString(input, "budgetDifficulty", "$.budgetDifficulty", issues, {
    nonEmpty: true,
  });
  const runTokenBudget = optionalInteger(input, "runTokenBudget", "$.runTokenBudget", issues, {
    min: 1,
  });
  const maxRounds = optionalInteger(input, "maxRounds", "$.maxRounds", issues, {
    min: 1,
  });
  const maxStalledRounds = optionalInteger(input, "maxStalledRounds", "$.maxStalledRounds", issues, {
    min: 1,
  });
  const backgroundDrainTimeoutMs = optionalInteger(input, "backgroundDrainTimeoutMs", "$.backgroundDrainTimeoutMs", issues, {
    min: 0,
  });
  const permissionMode = optionalEnum(
    input,
    "permissionMode",
    "$.permissionMode",
    ["ask", "auto", "full-access", "plan"],
    issues
  );
  const workspaceRoot = optionalString(input, "workspaceRoot", "$.workspaceRoot", issues, {
    nonEmpty: true,
  });
  const projectRoot = optionalString(input, "projectRoot", "$.projectRoot", issues, {
    nonEmpty: true,
  });
  const projectMarkers = optionalStringArray(input, "projectMarkers", "$.projectMarkers", issues);
  const projectFiles = optionalStringArray(input, "projectFiles", "$.projectFiles", issues);
  const projectTags = optionalStringArray(input, "projectTags", "$.projectTags", issues);
  const packageNames = optionalStringArray(input, "packageNames", "$.packageNames", issues);
  if ("scopedContextConfig" in input) {
    validateScopedContextRuntimeConfig(input.scopedContextConfig, "$.scopedContextConfig", issues);
  }

  if (issues.length > 0) return invalid("Invalid run-task message", issues);

  return ok({
    type: "run-task",
    runId: runId ?? "",
    ...(sessionId !== undefined ? { sessionId } : {}),
    prompt: prompt as string,
    ...(mode !== undefined ? { mode } : {}),
    ...(workspaceMode !== undefined ? { workspaceMode } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(visibleGoal !== undefined ? { visibleGoal } : {}),
    ...(budgetDifficulty !== undefined ? { budgetDifficulty } : {}),
    ...(runTokenBudget !== undefined ? { runTokenBudget } : {}),
    ...(maxRounds !== undefined ? { maxRounds } : {}),
    ...(maxStalledRounds !== undefined ? { maxStalledRounds } : {}),
    ...(backgroundDrainTimeoutMs !== undefined ? { backgroundDrainTimeoutMs } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    ...(projectMarkers !== undefined ? { projectMarkers } : {}),
    ...(projectFiles !== undefined ? { projectFiles } : {}),
    ...(projectTags !== undefined ? { projectTags } : {}),
    ...(packageNames !== undefined ? { packageNames } : {}),
    ...("scopedContextConfig" in input ? { scopedContextConfig: input.scopedContextConfig as RunTaskMessage["scopedContextConfig"] } : {}),
  });
}

export function validateApproveToolMessage(
  input: UnknownRecord
): ProtocolValidationResult<ApproveToolMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, APPROVE_TOOL_FIELDS, issues);

  const toolCallId = requiredString(
    input,
    "toolCallId",
    "$.toolCallId",
    issues,
    { nonEmpty: true }
  );
  const scope = optionalEnum(
    input,
    "scope",
    "$.scope",
    ["project", "always"],
    issues
  );

  if (issues.length > 0) return invalid("Invalid approve-tool message", issues);

  return ok({
    type: "approve-tool",
    toolCallId: toolCallId as string,
    ...(scope !== undefined ? { scope } : {}),
  });
}

export function validateDenyToolMessage(
  input: UnknownRecord
): ProtocolValidationResult<DenyToolMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, DENY_TOOL_FIELDS, issues);

  const toolCallId = requiredString(
    input,
    "toolCallId",
    "$.toolCallId",
    issues,
    { nonEmpty: true }
  );

  if (issues.length > 0) return invalid("Invalid deny-tool message", issues);

  return ok({ type: "deny-tool", toolCallId: toolCallId as string });
}

export function validateCancelRunMessage(
  input: UnknownRecord
): ProtocolValidationResult<CancelRunMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CANCEL_RUN_FIELDS, issues);

  const runId = requiredString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid cancel-run message", issues);

  return ok({ type: "cancel-run", runId: runId as string });
}

export function validatePingMessage(
  input: UnknownRecord
): ProtocolValidationResult<PingMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, EMPTY_COMMAND_FIELDS, issues);

  if (issues.length > 0) return invalid("Invalid ping message", issues);

  return ok({ type: "ping" });
}

export function validateGetStatusMessage(
  input: UnknownRecord
): ProtocolValidationResult<GetStatusMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, EMPTY_COMMAND_FIELDS, issues);

  if (issues.length > 0) return invalid("Invalid get-status message", issues);

  return ok({ type: "get-status" });
}

export function validateListCapabilitiesMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListCapabilitiesMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, EMPTY_COMMAND_FIELDS, issues);

  if (issues.length > 0) return invalid("Invalid list-capabilities message", issues);

  return ok({ type: "list-capabilities" });
}

export function validateUpdateConfigMessage(
  input: UnknownRecord
): ProtocolValidationResult<UpdateConfigMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, UPDATE_CONFIG_FIELDS, issues);

  const apiKey = optionalString(input, "apiKey", "$.apiKey", issues);
  const baseUrl = optionalString(input, "baseUrl", "$.baseUrl", issues);
  const model = optionalString(input, "model", "$.model", issues);
  const credentialMode = optionalEnum(
    input,
    "credentialMode",
    "$.credentialMode",
    PROVIDER_CREDENTIAL_MODES,
    issues
  );
  const endpoint = optionalEnum(
    input,
    "endpoint",
    "$.endpoint",
    PROVIDER_ENDPOINTS,
    issues
  );
  const stream = optionalBoolean(input, "stream", "$.stream", issues);

  if (issues.length > 0) return invalid("Invalid update-config message", issues);

  return ok({
    type: "update-config",
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(credentialMode !== undefined ? { credentialMode } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(stream !== undefined ? { stream } : {}),
  });
}

export function validateListSessionsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListSessionsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, LIST_SESSIONS_FIELDS, issues);
  const includeArchived = optionalBoolean(input, "includeArchived", "$.includeArchived", issues);
  const includeDeleted = optionalBoolean(input, "includeDeleted", "$.includeDeleted", issues);

  if (issues.length > 0) return invalid("Invalid list-sessions message", issues);

  return ok({
    type: "list-sessions",
    ...(includeArchived !== undefined ? { includeArchived } : {}),
    ...(includeDeleted !== undefined ? { includeDeleted } : {}),
  });
}

export function validateListRunsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListRunsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, LIST_RUNS_FIELDS, issues);

  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid list-runs message", issues);

  return ok({
    type: "list-runs",
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

export function validateReadSessionEventsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ReadSessionEventsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, READ_SESSION_EVENTS_FIELDS, issues);

  const sessionId = requiredString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });
  const afterSequence = optionalInteger(
    input,
    "afterSequence",
    "$.afterSequence",
    issues,
    { min: 0 }
  );
  const lastEventId = optionalString(input, "lastEventId", "$.lastEventId", issues, {
    nonEmpty: true,
  });
  const maxEvents = optionalInteger(
    input,
    "maxEvents",
    "$.maxEvents",
    issues,
    { min: 1 }
  );
  const cursor = optionalEventReplayCursor(input, "cursor", "$.cursor", issues);

  if (issues.length > 0) {
    return invalid("Invalid read-session-events message", issues);
  }

  return ok({
    type: "read-session-events",
    sessionId: sessionId as string,
    ...(afterSequence !== undefined ? { afterSequence } : {}),
    ...(lastEventId !== undefined ? { lastEventId } : {}),
    ...(maxEvents !== undefined ? { maxEvents } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  });
}

export function validateReadRunEventsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ReadRunEventsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, READ_RUN_EVENTS_FIELDS, issues);

  const runId = requiredString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });
  const afterSequence = optionalInteger(
    input,
    "afterSequence",
    "$.afterSequence",
    issues,
    { min: 0 }
  );
  const lastEventId = optionalString(input, "lastEventId", "$.lastEventId", issues, {
    nonEmpty: true,
  });
  const includeSnapshot = optionalBoolean(
    input,
    "includeSnapshot",
    "$.includeSnapshot",
    issues
  );
  const maxEvents = optionalInteger(
    input,
    "maxEvents",
    "$.maxEvents",
    issues,
    { min: 1 }
  );
  const cursor = optionalEventReplayCursor(input, "cursor", "$.cursor", issues);

  if (issues.length > 0) {
    return invalid("Invalid read-run-events message", issues);
  }

  return ok({
    type: "read-run-events",
    runId: runId as string,
    ...(afterSequence !== undefined ? { afterSequence } : {}),
    ...(lastEventId !== undefined ? { lastEventId } : {}),
    ...(includeSnapshot !== undefined ? { includeSnapshot } : {}),
    ...(maxEvents !== undefined ? { maxEvents } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  });
}

export function validateGetRunSnapshotMessage(
  input: UnknownRecord
): ProtocolValidationResult<GetRunSnapshotMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GET_RUN_SNAPSHOT_FIELDS, issues);

  const runId = requiredString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) {
    return invalid("Invalid get-run-snapshot message", issues);
  }

  return ok({ type: "get-run-snapshot", runId: runId as string });
}

export function validateEnqueuePendingInputMessage(
  input: UnknownRecord
): ProtocolValidationResult<EnqueuePendingInputMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, ENQUEUE_PENDING_INPUT_FIELDS, issues);

  const sessionId = requiredString(input, "sessionId", "$.sessionId", issues, { nonEmpty: true });
  const text = requiredString(input, "text", "$.text", issues, { nonEmpty: true });
  const runId = optionalString(input, "runId", "$.runId", issues, { nonEmpty: true });
  const mode = optionalEnum(input, "mode", "$.mode", PENDING_INPUT_MODES, issues);
  const inputId = optionalString(input, "inputId", "$.inputId", issues, { nonEmpty: true });
  const source = optionalEnum(input, "source", "$.source", PENDING_INPUT_SOURCES, issues);
  if ("metadata" in input && !isRecord(input.metadata)) {
    issues.push({ path: "$.metadata", message: "Expected object" });
  }

  if (issues.length > 0) return invalid("Invalid enqueue-pending-input message", issues);

  return ok({
    type: "enqueue-pending-input",
    sessionId: sessionId as string,
    text: text as string,
    ...(runId !== undefined ? { runId } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(inputId !== undefined ? { inputId } : {}),
    ...(source !== undefined ? { source } : {}),
    ...("metadata" in input ? { metadata: input.metadata as JsonObject } : {}),
  });
}

export function validateCancelPendingInputMessage(
  input: UnknownRecord
): ProtocolValidationResult<CancelPendingInputMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CANCEL_PENDING_INPUT_FIELDS, issues);

  const inputId = requiredString(input, "inputId", "$.inputId", issues, { nonEmpty: true });
  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, { nonEmpty: true });
  const reason = optionalString(input, "reason", "$.reason", issues, { nonEmpty: true });

  if (issues.length > 0) return invalid("Invalid cancel-pending-input message", issues);

  return ok({
    type: "cancel-pending-input",
    inputId: inputId as string,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(reason !== undefined ? { reason } : {}),
  });
}

export function validateDispatchPendingInputMessage(
  input: UnknownRecord
): ProtocolValidationResult<DispatchPendingInputMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, DISPATCH_PENDING_INPUT_FIELDS, issues);

  const inputId = requiredString(input, "inputId", "$.inputId", issues, { nonEmpty: true });
  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, { nonEmpty: true });
  const targetRunId = optionalString(input, "targetRunId", "$.targetRunId", issues, { nonEmpty: true });

  if (issues.length > 0) return invalid("Invalid dispatch-pending-input message", issues);

  return ok({
    type: "dispatch-pending-input",
    inputId: inputId as string,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(targetRunId !== undefined ? { targetRunId } : {}),
  });
}

export function validateListPendingInputsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListPendingInputsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, LIST_PENDING_INPUTS_FIELDS, issues);

  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, { nonEmpty: true });

  if (issues.length > 0) return invalid("Invalid list-pending-inputs message", issues);

  return ok({
    type: "list-pending-inputs",
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

export function validateListWorkflowsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListWorkflowsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, EMPTY_COMMAND_FIELDS, issues);

  if (issues.length > 0) return invalid("Invalid list-workflows message", issues);

  return ok({ type: "list-workflows" });
}

export function validateCreateWorkflowMessage(
  input: UnknownRecord
): ProtocolValidationResult<CreateWorkflowMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CREATE_WORKFLOW_FIELDS, issues);

  const id = optionalString(input, "id", "$.id", issues, { nonEmpty: true });
  const name = requiredString(input, "name", "$.name", issues, { nonEmpty: true });
  const prompt = requiredString(input, "prompt", "$.prompt", issues, {
    nonEmpty: true,
  });
  const cwd = optionalString(input, "cwd", "$.cwd", issues, { nonEmpty: true });
  const mode = optionalString(input, "mode", "$.mode", issues, { nonEmpty: true });
  const schedule = requiredWorkflowSchedule(input, "schedule", "$.schedule", issues);
  const enabled = optionalBoolean(input, "enabled", "$.enabled", issues);
  const metadata = optionalJsonObject(input, "metadata", "$.metadata", issues);

  if (issues.length > 0) return invalid("Invalid create-workflow message", issues);

  return ok({
    type: "create-workflow",
    ...(id !== undefined ? { id } : {}),
    name: name as string,
    prompt: prompt as string,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(mode !== undefined ? { mode } : {}),
    schedule: schedule as CreateWorkflowMessage["schedule"],
    ...(enabled !== undefined ? { enabled } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  });
}

export function validateUpdateWorkflowMessage(
  input: UnknownRecord
): ProtocolValidationResult<UpdateWorkflowMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, UPDATE_WORKFLOW_FIELDS, issues);

  const workflowId = requiredString(input, "workflowId", "$.workflowId", issues, {
    nonEmpty: true,
  });
  const name = optionalString(input, "name", "$.name", issues, { nonEmpty: true });
  const prompt = optionalString(input, "prompt", "$.prompt", issues, {
    nonEmpty: true,
  });
  const cwd = optionalString(input, "cwd", "$.cwd", issues, { nonEmpty: true });
  const mode = optionalString(input, "mode", "$.mode", issues, { nonEmpty: true });
  const schedule = optionalWorkflowSchedule(input, "schedule", "$.schedule", issues);
  const enabled = optionalBoolean(input, "enabled", "$.enabled", issues);
  const metadata = optionalJsonObject(input, "metadata", "$.metadata", issues);

  if (issues.length > 0) return invalid("Invalid update-workflow message", issues);

  return ok({
    type: "update-workflow",
    workflowId: workflowId as string,
    ...(name !== undefined ? { name } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(schedule !== undefined ? { schedule } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  });
}

export function validateDeleteWorkflowMessage(
  input: UnknownRecord
): ProtocolValidationResult<DeleteWorkflowMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, DELETE_WORKFLOW_FIELDS, issues);

  const workflowId = requiredString(input, "workflowId", "$.workflowId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid delete-workflow message", issues);

  return ok({ type: "delete-workflow", workflowId: workflowId as string });
}

export function validateTriggerWorkflowMessage(
  input: UnknownRecord
): ProtocolValidationResult<TriggerWorkflowMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, TRIGGER_WORKFLOW_FIELDS, issues);

  const workflowId = requiredString(input, "workflowId", "$.workflowId", issues, {
    nonEmpty: true,
  });
  const runId = optionalString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });
  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid trigger-workflow message", issues);

  return ok({
    type: "trigger-workflow",
    workflowId: workflowId as string,
    ...(runId !== undefined ? { runId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

export function validateListWorkflowRunsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListWorkflowRunsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, LIST_WORKFLOW_RUNS_FIELDS, issues);

  const workflowId = optionalString(input, "workflowId", "$.workflowId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid list-workflow-runs message", issues);

  return ok({
    type: "list-workflow-runs",
    ...(workflowId !== undefined ? { workflowId } : {}),
  });
}

export function validateGitStatusMessage(
  input: UnknownRecord
): ProtocolValidationResult<GitStatusMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GIT_STATUS_FIELDS, issues);

  const cwd = optionalString(input, "cwd", "$.cwd", issues, { nonEmpty: true });

  if (issues.length > 0) return invalid("Invalid git-status message", issues);

  return ok({
    type: "git-status",
    ...(cwd !== undefined ? { cwd } : {}),
  });
}

export function validateGitDiffMessage(
  input: UnknownRecord
): ProtocolValidationResult<GitDiffMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GIT_DIFF_FIELDS, issues);

  const cwd = optionalString(input, "cwd", "$.cwd", issues, { nonEmpty: true });
  const path = optionalString(input, "path", "$.path", issues, { nonEmpty: true });
  const staged = optionalBoolean(input, "staged", "$.staged", issues);

  if (issues.length > 0) return invalid("Invalid git-diff message", issues);

  return ok({
    type: "git-diff",
    ...(cwd !== undefined ? { cwd } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(staged !== undefined ? { staged } : {}),
  });
}

export function validateListPlanDocumentsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListPlanDocumentsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, EMPTY_COMMAND_FIELDS, issues);

  if (issues.length > 0) return invalid("Invalid list-plan-documents message", issues);

  return ok({ type: "list-plan-documents" });
}

export function validateCreatePlanDocumentMessage(
  input: UnknownRecord
): ProtocolValidationResult<CreatePlanDocumentMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CREATE_PLAN_DOCUMENT_FIELDS, issues);

  const id = optionalString(input, "id", "$.id", issues, { nonEmpty: true });
  const title = requiredString(input, "title", "$.title", issues, { nonEmpty: true });
  const goal = requiredString(input, "goal", "$.goal", issues, { nonEmpty: true });
  const assumptions = optionalArray(input, "assumptions", "$.assumptions", issues);
  const questions = optionalArray(input, "questions", "$.questions", issues);
  const steps = optionalArray(input, "steps", "$.steps", issues);
  const acceptance = optionalArray(input, "acceptance", "$.acceptance", issues);
  const risks = optionalArray(input, "risks", "$.risks", issues);
  const status = optionalString(input, "status", "$.status", issues, { nonEmpty: true });
  const version = optionalInteger(input, "version", "$.version", issues, { min: 1 });
  const createdAt = optionalString(input, "createdAt", "$.createdAt", issues, { nonEmpty: true });
  const updatedAt = optionalString(input, "updatedAt", "$.updatedAt", issues, { nonEmpty: true });
  const metadata = optionalJsonObject(input, "metadata", "$.metadata", issues);

  if (issues.length > 0) return invalid("Invalid create-plan-document message", issues);

  return ok({
    type: "create-plan-document",
    ...(id !== undefined ? { id } : {}),
    title: title as string,
    goal: goal as string,
    ...(assumptions !== undefined ? { assumptions: assumptions as CreatePlanDocumentMessage["assumptions"] } : {}),
    ...(questions !== undefined ? { questions: questions as CreatePlanDocumentMessage["questions"] } : {}),
    ...(steps !== undefined ? { steps: steps as CreatePlanDocumentMessage["steps"] } : {}),
    ...(acceptance !== undefined ? { acceptance: acceptance as CreatePlanDocumentMessage["acceptance"] } : {}),
    ...(risks !== undefined ? { risks: risks as CreatePlanDocumentMessage["risks"] } : {}),
    ...(status !== undefined ? { status: status as CreatePlanDocumentMessage["status"] } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  });
}

export function validateCreateRequirementsAlignmentPlanMessage(
  input: UnknownRecord
): ProtocolValidationResult<CreateRequirementsAlignmentPlanMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CREATE_REQUIREMENTS_ALIGNMENT_PLAN_FIELDS, issues);

  const id = optionalString(input, "id", "$.id", issues, { nonEmpty: true });
  const title = optionalString(input, "title", "$.title", issues, { nonEmpty: true });
  const goal = requiredString(input, "goal", "$.goal", issues, { nonEmpty: true });
  const context = optionalString(input, "context", "$.context", issues, { nonEmpty: true });
  const questions = optionalStringArray(input, "questions", "$.questions", issues);
  const assumptions = optionalStringArray(input, "assumptions", "$.assumptions", issues);
  const acceptance = optionalStringArray(input, "acceptance", "$.acceptance", issues);
  const risks = optionalStringArray(input, "risks", "$.risks", issues);
  const source = optionalEnum(
    input,
    "source",
    "$.source",
    ["user", "assistant", "slash-command", "workflow", "system"] as const,
    issues
  );
  const metadata = optionalJsonObject(input, "metadata", "$.metadata", issues);

  if (issues.length > 0) {
    return invalid("Invalid create-requirements-alignment-plan message", issues);
  }

  return ok({
    type: "create-requirements-alignment-plan",
    ...(id !== undefined ? { id } : {}),
    ...(title !== undefined ? { title } : {}),
    goal: goal as string,
    ...(context !== undefined ? { context } : {}),
    ...(questions !== undefined ? { questions } : {}),
    ...(assumptions !== undefined ? { assumptions } : {}),
    ...(acceptance !== undefined ? { acceptance } : {}),
    ...(risks !== undefined ? { risks } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  });
}

export function validateGetPlanDocumentMessage(
  input: UnknownRecord
): ProtocolValidationResult<GetPlanDocumentMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GET_PLAN_DOCUMENT_FIELDS, issues);
  const documentId = requiredString(input, "documentId", "$.documentId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid get-plan-document message", issues);

  return ok({ type: "get-plan-document", documentId: documentId as string });
}

export function validatePatchPlanDocumentMessage(
  input: UnknownRecord
): ProtocolValidationResult<PatchPlanDocumentMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PATCH_PLAN_DOCUMENT_FIELDS, issues);
  const documentId = requiredString(input, "documentId", "$.documentId", issues, {
    nonEmpty: true,
  });
  const patch = requiredPlanDocumentPatch(input, "patch", "$.patch", issues);

  if (issues.length > 0) return invalid("Invalid patch-plan-document message", issues);

  return ok({
    type: "patch-plan-document",
    documentId: documentId as string,
    patch: patch as PatchPlanDocumentMessage["patch"],
  });
}

export function validateDeletePlanDocumentMessage(
  input: UnknownRecord
): ProtocolValidationResult<DeletePlanDocumentMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, DELETE_PLAN_DOCUMENT_FIELDS, issues);
  const documentId = requiredString(input, "documentId", "$.documentId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid delete-plan-document message", issues);

  return ok({ type: "delete-plan-document", documentId: documentId as string });
}

export function validateListMutationLeasesMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListMutationLeasesMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, LIST_MUTATION_LEASES_FIELDS, issues);

  const cwd = optionalString(input, "cwd", "$.cwd", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid list-mutation-leases message", issues);

  return ok({
    type: "list-mutation-leases",
    ...(cwd !== undefined ? { cwd } : {}),
  });
}

export function validateListBackgroundTasksMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListBackgroundTasksMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, LIST_BACKGROUND_TASKS_FIELDS, issues);
  const includeHistory = optionalBoolean(input, "includeHistory", "$.includeHistory", issues);
  const state = optionalBackgroundTaskState(input, "state", "$.state", issues);
  const limit = optionalInteger(input, "limit", "$.limit", issues, { min: 1 });

  if (issues.length > 0) return invalid("Invalid list-background-tasks message", issues);

  return ok({
    type: "list-background-tasks",
    ...(includeHistory !== undefined ? { includeHistory } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
}

export function validateStartBackgroundTaskMessage(
  input: UnknownRecord
): ProtocolValidationResult<StartBackgroundTaskMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, START_BACKGROUND_TASK_FIELDS, issues);
  const command = requiredString(input, "command", "$.command", issues, { nonEmpty: true });
  const cwd = optionalString(input, "cwd", "$.cwd", issues, { nonEmpty: true });
  const workspaceRoot = optionalString(input, "workspaceRoot", "$.workspaceRoot", issues, { nonEmpty: true });
  const timeoutMs = optionalNumber(input, "timeoutMs", "$.timeoutMs", issues, { min: 1 });
  const maxOutputBytes = optionalNumber(input, "maxOutputBytes", "$.maxOutputBytes", issues, { min: 1 });
  const heartbeatIntervalMs = optionalNumber(input, "heartbeatIntervalMs", "$.heartbeatIntervalMs", issues, { min: 1 });

  if (issues.length > 0) return invalid("Invalid start-background-task message", issues);

  return ok({
    type: "start-background-task",
    command: command as string,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
    ...(heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs } : {}),
  });
}

export function validateCancelBackgroundTaskMessage(
  input: UnknownRecord
): ProtocolValidationResult<CancelBackgroundTaskMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CANCEL_BACKGROUND_TASK_FIELDS, issues);
  const taskId = requiredString(input, "taskId", "$.taskId", issues, { nonEmpty: true });

  if (issues.length > 0) return invalid("Invalid cancel-background-task message", issues);

  return ok({ type: "cancel-background-task", taskId: taskId as string });
}

export function validateGetBackgroundTaskHistoryMessage(
  input: UnknownRecord
): ProtocolValidationResult<GetBackgroundTaskHistoryMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GET_BACKGROUND_TASK_HISTORY_FIELDS, issues);
  const state = optionalBackgroundTaskState(input, "state", "$.state", issues);
  const limit = optionalInteger(input, "limit", "$.limit", issues, { min: 1 });

  if (issues.length > 0) return invalid("Invalid get-background-task-history message", issues);

  return ok({
    type: "get-background-task-history",
    ...(state !== undefined ? { state } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
}

function optionalBackgroundTaskState(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): (typeof BACKGROUND_TASK_STATES)[number] | undefined {
  return optionalEnum(input, key, path, BACKGROUND_TASK_STATES, issues);
}

export function validateListArtifactsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListArtifactsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, LIST_ARTIFACTS_FIELDS, issues);

  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid list-artifacts message", issues);

  return ok({
    type: "list-artifacts",
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

export function validateGetArtifactContentMessage(
  input: UnknownRecord
): ProtocolValidationResult<GetArtifactContentMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GET_ARTIFACT_CONTENT_FIELDS, issues);

  const artifactUri = requiredString(input, "artifactUri", "$.artifactUri", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid get-artifact-content message", issues);

  return ok({
    type: "get-artifact-content",
    artifactUri: artifactUri as string,
  });
}

export function validateListMemoriesMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListMemoriesMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, LIST_MEMORIES_FIELDS, issues);

  const scope = optionalString(input, "scope", "$.scope", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid list-memories message", issues);

  return ok({
    type: "list-memories",
    ...(scope !== undefined ? { scope } : {}),
  });
}

export function validateDeleteMemoryMessage(
  input: UnknownRecord
): ProtocolValidationResult<DeleteMemoryMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, DELETE_MEMORY_FIELDS, issues);

  const memoryId = requiredString(input, "memoryId", "$.memoryId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid delete-memory message", issues);

  return ok({
    type: "delete-memory",
    memoryId: memoryId as string,
  });
}

export function validateListCheckpointsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListCheckpointsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, LIST_CHECKPOINTS_FIELDS, issues);

  const runId = optionalString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });
  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid list-checkpoints message", issues);

  return ok({
    type: "list-checkpoints",
    ...(runId !== undefined ? { runId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

export function validateRestoreCheckpointMessage(
  input: UnknownRecord
): ProtocolValidationResult<RestoreCheckpointMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, RESTORE_CHECKPOINT_FIELDS, issues);

  const checkpointId = requiredString(input, "checkpointId", "$.checkpointId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid restore-checkpoint message", issues);

  return ok({
    type: "restore-checkpoint",
    checkpointId: checkpointId as string,
  });
}

export function validateGetCheckpointDiffMessage(
  input: UnknownRecord
): ProtocolValidationResult<GetCheckpointDiffMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GET_CHECKPOINT_DIFF_FIELDS, issues);

  const checkpointId = requiredString(input, "checkpointId", "$.checkpointId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid get-checkpoint-diff message", issues);

  return ok({
    type: "get-checkpoint-diff",
    checkpointId: checkpointId as string,
  });
}

export function validatePreviewConversationRewindMessage(
  input: UnknownRecord
): ProtocolValidationResult<PreviewConversationRewindMessage> {
  return validateConversationRewindRequest(input, "preview-conversation-rewind");
}

export function validateResolveConversationRewindBoundaryMessage(
  input: UnknownRecord
): ProtocolValidationResult<ResolveConversationRewindBoundaryMessage> {
  const result = validateConversationRewindBoundaryRequest(input, "resolve-conversation-rewind-boundary");
  return result as ProtocolValidationResult<ResolveConversationRewindBoundaryMessage>;
}

export function validatePreviewConversationRewindByBoundaryMessage(
  input: UnknownRecord
): ProtocolValidationResult<PreviewConversationRewindByBoundaryMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PREVIEW_CONVERSATION_REWIND_BY_BOUNDARY_FIELDS, issues);

  const base = readConversationRewindBoundaryRequest(input, issues);
  const restorePolicy = optionalEnum(
    input,
    "restorePolicy",
    "$.restorePolicy",
    ["if-present", "required", "skip"],
    issues
  );
  if ("activeSubagents" in input) {
    const activeSubagents = requiredArray(input, "activeSubagents", "$.activeSubagents", issues);
    activeSubagents?.forEach((subagent, index) =>
      validateConversationRewindActiveSubagent(subagent, `$.activeSubagents[${index}]`, issues)
    );
  }

  if (issues.length > 0) return invalid("Invalid preview-conversation-rewind-by-boundary message", issues);

  return ok({
    type: "preview-conversation-rewind-by-boundary",
    ...base,
    ...(restorePolicy !== undefined ? { restorePolicy } : {}),
    ...("activeSubagents" in input
      ? { activeSubagents: input.activeSubagents as PreviewConversationRewindByBoundaryMessage["activeSubagents"] }
      : {}),
  });
}

export function validateApplyConversationRewindMessage(
  input: UnknownRecord
): ProtocolValidationResult<ApplyConversationRewindMessage> {
  return validateConversationRewindRequest(input, "apply-conversation-rewind");
}

export function validateApplySessionActionMessage(
  input: UnknownRecord
): ProtocolValidationResult<ApplySessionActionMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, APPLY_SESSION_ACTION_FIELDS, issues);

  const actionRecord = requiredRecord(input, "action", "$.action", issues);
  const action = actionRecord ? readSessionAction(actionRecord, "$.action", issues) : undefined;

  if (issues.length > 0) return invalid("Invalid apply-session-action message", issues);

  return ok({
    type: "apply-session-action",
    action: action as SessionAction,
  });
}

function readSessionAction(
  input: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): SessionAction | undefined {
  const kind = requiredEnum(input, "kind", `${path}.kind`, SESSION_ACTION_KINDS, issues);
  rejectUnknownFields(input, sessionActionFields(kind), issues, path);

  const protocolVersion = requiredInteger(input, "protocolVersion", `${path}.protocolVersion`, issues, {
    min: 1,
  });
  if (protocolVersion !== undefined && protocolVersion !== SESSION_ACTION_PROTOCOL_VERSION) {
    issues.push({
      path: `${path}.protocolVersion`,
      message: `Expected session action protocol version ${SESSION_ACTION_PROTOCOL_VERSION}`,
    });
  }
  const actionId = requiredString(input, "actionId", `${path}.actionId`, issues, { nonEmpty: true });
  const sessionId = requiredString(input, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  const requestedAt = requiredString(input, "requestedAt", `${path}.requestedAt`, issues, { nonEmpty: true });
  const requestedBy = requiredEnum(
    input,
    "requestedBy",
    `${path}.requestedBy`,
    ["workbench", "daemon", "automation"] as const,
    issues
  );
  const idempotencyKey = optionalString(input, "idempotencyKey", `${path}.idempotencyKey`, issues, {
    nonEmpty: true,
  });
  if ("consistency" in input) {
    validateSessionActionConsistency(input.consistency, `${path}.consistency`, issues);
  }

  if (kind === undefined) return undefined;

  const base = {
    protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
    actionId: actionId as string,
    kind,
    sessionId: sessionId as string,
    requestedAt: requestedAt as string,
    requestedBy: requestedBy as SessionAction["requestedBy"],
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ...("consistency" in input ? { consistency: input.consistency as SessionAction["consistency"] } : {}),
  };

  switch (kind) {
    case "pin":
    case "unpin":
    case "archive":
    case "unarchive":
    case "delete":
      return base as SessionAction;
    case "rename": {
      const title = requiredString(input, "title", `${path}.title`, issues, { nonEmpty: true });
      return { ...base, title: title as string } as SessionAction;
    }
    case "fork": {
      const fromEventId = optionalString(input, "fromEventId", `${path}.fromEventId`, issues, { nonEmpty: true });
      const fromMessageId = optionalString(input, "fromMessageId", `${path}.fromMessageId`, issues, { nonEmpty: true });
      const targetSessionId = optionalString(input, "targetSessionId", `${path}.targetSessionId`, issues, { nonEmpty: true });
      return {
        ...base,
        ...(fromEventId !== undefined ? { fromEventId } : {}),
        ...(fromMessageId !== undefined ? { fromMessageId } : {}),
        ...(targetSessionId !== undefined ? { targetSessionId } : {}),
      } as SessionAction;
    }
    case "rewind": {
      const targetEventId = requiredString(input, "targetEventId", `${path}.targetEventId`, issues, { nonEmpty: true });
      const restoreWorkspace = requiredBoolean(input, "restoreWorkspace", `${path}.restoreWorkspace`, issues);
      return {
        ...base,
        targetEventId: targetEventId as string,
        restoreWorkspace: restoreWorkspace as boolean,
      } as SessionAction;
    }
    case "open": {
      const target = requiredEnum(input, "target", `${path}.target`, SESSION_OPEN_TARGETS, issues);
      const paneId = optionalString(input, "paneId", `${path}.paneId`, issues, { nonEmpty: true });
      return {
        ...base,
        target: target as Extract<SessionAction, { kind: "open" }>["target"],
        ...(paneId !== undefined ? { paneId } : {}),
      } as SessionAction;
    }
  }
}

function sessionActionFields(kind: SessionActionKind | undefined): readonly string[] {
  switch (kind) {
    case "rename":
      return [...SESSION_ACTION_BASE_FIELDS, "title"];
    case "fork":
      return [...SESSION_ACTION_BASE_FIELDS, "fromEventId", "fromMessageId", "targetSessionId"];
    case "rewind":
      return [...SESSION_ACTION_BASE_FIELDS, "targetEventId", "restoreWorkspace"];
    case "open":
      return [...SESSION_ACTION_BASE_FIELDS, "target", "paneId"];
    default:
      return [
        ...SESSION_ACTION_BASE_FIELDS,
        "title",
        "fromEventId",
        "fromMessageId",
        "targetSessionId",
        "targetEventId",
        "restoreWorkspace",
        "target",
        "paneId",
      ];
  }
}

export function validateSessionActionConsistency(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SESSION_ACTION_CONSISTENCY_FIELDS, issues, path);
  if ("expectedSessionVersion" in value) {
    optionalString(value, "expectedSessionVersion", `${path}.expectedSessionVersion`, issues, { nonEmpty: true });
  }
  if ("eventLogCursor" in value) {
    optionalString(value, "eventLogCursor", `${path}.eventLogCursor`, issues, { nonEmpty: true });
  }
  if ("workspaceVersionId" in value) {
    optionalString(value, "workspaceVersionId", `${path}.workspaceVersionId`, issues, { nonEmpty: true });
  }
  if ("parentActionId" in value) {
    optionalString(value, "parentActionId", `${path}.parentActionId`, issues, { nonEmpty: true });
  }
}

export function validateConversationRewindBoundaryRequest<TType extends "resolve-conversation-rewind-boundary">(
  input: UnknownRecord,
  type: TType
): ProtocolValidationResult<ResolveConversationRewindBoundaryMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CONVERSATION_REWIND_BOUNDARY_REQUEST_FIELDS, issues);
  const base = readConversationRewindBoundaryRequest(input, issues);

  if (issues.length > 0) return invalid(`Invalid ${type} message`, issues);

  return ok({
    type,
    ...base,
  });
}

function readConversationRewindBoundaryRequest(
  input: UnknownRecord,
  issues: ProtocolValidationIssue[]
): Omit<ResolveConversationRewindBoundaryMessage, "type"> {
  const sessionId = requiredString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });
  const userMessageId = optionalString(input, "userMessageId", "$.userMessageId", issues, {
    nonEmpty: true,
  });
  const latestUserMessage = optionalBoolean(input, "latestUserMessage", "$.latestUserMessage", issues);
  const mode = optionalEnum(
    input,
    "mode",
    "$.mode",
    ["keep-user-message", "remove-user-message"],
    issues
  );

  if (latestUserMessage !== true && userMessageId === undefined) {
    issues.push({ path: "$.userMessageId", message: "Required unless latestUserMessage is true" });
  }
  if (latestUserMessage === true && userMessageId !== undefined) {
    issues.push({ path: "$.userMessageId", message: "Must be omitted when latestUserMessage is true" });
  }

  return {
    sessionId: sessionId as string,
    ...(userMessageId !== undefined ? { userMessageId } : {}),
    ...(latestUserMessage !== undefined ? { latestUserMessage } : {}),
    ...(mode !== undefined ? { mode } : {}),
  };
}

export function validateConversationRewindRequest<TType extends "preview-conversation-rewind" | "apply-conversation-rewind">(
  input: UnknownRecord,
  type: TType
): ProtocolValidationResult<TType extends "preview-conversation-rewind" ? PreviewConversationRewindMessage : ApplyConversationRewindMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CONVERSATION_REWIND_REQUEST_FIELDS, issues);

  const sessionId = requiredString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });
  const targetLeafId =
    "targetLeafId" in input
      ? readNullableString(input.targetLeafId, "$.targetLeafId", issues)
      : undefined;
  const entries = "entries" in input ? requiredArray(input, "entries", "$.entries", issues) : undefined;
  const userMessageId = optionalString(input, "userMessageId", "$.userMessageId", issues, {
    nonEmpty: true,
  });
  const latestUserMessage = optionalBoolean(input, "latestUserMessage", "$.latestUserMessage", issues);
  const mode = optionalEnum(
    input,
    "mode",
    "$.mode",
    ["keep-user-message", "remove-user-message"],
    issues
  );
  const restorePolicy = optionalEnum(
    input,
    "restorePolicy",
    "$.restorePolicy",
    ["if-present", "required", "skip"],
    issues
  );
  if (entries) {
    entries.forEach((entry, index) =>
      validateSessionTreeEntry(entry, `$.entries[${index}]`, issues)
    );
  }
  const hasExplicitTarget = "targetLeafId" in input || "entries" in input;
  const hasBoundarySelector = userMessageId !== undefined || latestUserMessage !== undefined || mode !== undefined;
  if (type === "preview-conversation-rewind" || hasExplicitTarget) {
    if (!("targetLeafId" in input)) {
      issues.push({ path: "$.targetLeafId", message: "Required field is missing" });
    }
    if (!("entries" in input)) {
      issues.push({ path: "$.entries", message: "Required field is missing" });
    }
  }
  if (type === "apply-conversation-rewind" && !hasExplicitTarget && !hasBoundarySelector) {
    issues.push({ path: "$.userMessageId", message: "Required unless targetLeafId and entries are provided" });
  }
  if (hasExplicitTarget && hasBoundarySelector) {
    issues.push({ path: "$.userMessageId", message: "Must be omitted when targetLeafId or entries are provided" });
  }
  if (latestUserMessage === true && userMessageId !== undefined) {
    issues.push({ path: "$.userMessageId", message: "Must be omitted when latestUserMessage is true" });
  }
  if (latestUserMessage !== true && hasBoundarySelector && userMessageId === undefined) {
    issues.push({ path: "$.userMessageId", message: "Required unless latestUserMessage is true" });
  }
  if ("checkpoint" in input) {
    validateConversationRewindCheckpoint(input.checkpoint, "$.checkpoint", issues);
  }
  if ("activeSubagents" in input) {
    const activeSubagents = requiredArray(input, "activeSubagents", "$.activeSubagents", issues);
    activeSubagents?.forEach((subagent, index) =>
      validateConversationRewindActiveSubagent(subagent, `$.activeSubagents[${index}]`, issues)
    );
  }

  if (issues.length > 0) return invalid(`Invalid ${type} message`, issues);

  return ok({
    type,
    sessionId: sessionId as string,
    ...("targetLeafId" in input ? { targetLeafId: targetLeafId as string | null } : {}),
    ...("entries" in input ? { entries: entries as PreviewConversationRewindMessage["entries"] } : {}),
    ...(userMessageId !== undefined ? { userMessageId } : {}),
    ...(latestUserMessage !== undefined ? { latestUserMessage } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...("checkpoint" in input ? { checkpoint: input.checkpoint as PreviewConversationRewindMessage["checkpoint"] } : {}),
    ...(restorePolicy !== undefined ? { restorePolicy } : {}),
    ...("activeSubagents" in input
      ? { activeSubagents: input.activeSubagents as PreviewConversationRewindMessage["activeSubagents"] }
      : {}),
  } as TType extends "preview-conversation-rewind" ? PreviewConversationRewindMessage : ApplyConversationRewindMessage);
}

export function validateSendToSubagentMessage(
  input: UnknownRecord
): ProtocolValidationResult<SendToSubagentMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SEND_TO_SUBAGENT_FIELDS, issues);

  const subagentRunId = requiredString(input, "subagentRunId", "$.subagentRunId", issues, {
    nonEmpty: true,
  });
  const message = requiredString(input, "message", "$.message", issues);

  if (issues.length > 0) return invalid("Invalid send-to-subagent message", issues);

  return ok({
    type: "send-to-subagent",
    subagentRunId: subagentRunId as string,
    message: message as string,
  });
}

export function validateGetSubagentStatusMessage(
  input: UnknownRecord
): ProtocolValidationResult<GetSubagentStatusMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GET_SUBAGENT_STATUS_FIELDS, issues);

  const subagentRunId = requiredString(input, "subagentRunId", "$.subagentRunId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid get-subagent-status message", issues);

  return ok({
    type: "get-subagent-status",
    subagentRunId: subagentRunId as string,
  });
}

export function validateStartMcpServerMessage(
  input: UnknownRecord
): ProtocolValidationResult<StartMcpServerMessage> {
  return validateMcpServerControlMessage(input, "start-mcp-server");
}

export function validateStopMcpServerMessage(
  input: UnknownRecord
): ProtocolValidationResult<StopMcpServerMessage> {
  return validateMcpServerControlMessage(input, "stop-mcp-server");
}

export function validateMcpServerControlMessage<TType extends "start-mcp-server" | "stop-mcp-server">(
  input: UnknownRecord,
  type: TType
): ProtocolValidationResult<TType extends "start-mcp-server" ? StartMcpServerMessage : StopMcpServerMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, MCP_SERVER_CONTROL_FIELDS, issues);

  const serverId = requiredString(input, "serverId", "$.serverId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid(`Invalid ${type} message`, issues);

  return ok({
    type,
    serverId: serverId as string,
  } as TType extends "start-mcp-server" ? StartMcpServerMessage : StopMcpServerMessage);
}

export function validateListMcpServersMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListMcpServersMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, EMPTY_COMMAND_FIELDS, issues);

  if (issues.length > 0) return invalid("Invalid list-mcp-servers message", issues);

  return ok({ type: "list-mcp-servers" });
}

export function validateScopedContextRuntimeConfig(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SCOPED_CONTEXT_RUNTIME_CONFIG_FIELDS, issues, path);
  optionalStringArray(value, "userEnabledIds", `${path}.userEnabledIds`, issues);
  optionalStringArray(value, "userDisabledIds", `${path}.userDisabledIds`, issues);
  optionalBoolean(value, "includeRecommendationHints", `${path}.includeRecommendationHints`, issues);
  optionalBoolean(value, "includeAncestorContextFiles", `${path}.includeAncestorContextFiles`, issues);
  optionalBoolean(value, "includeProjectSkillDirs", `${path}.includeProjectSkillDirs`, issues);
  optionalBoolean(value, "includeWorkspaceSkillDirs", `${path}.includeWorkspaceSkillDirs`, issues);
  optionalBoolean(value, "includeGlobalSkillDirs", `${path}.includeGlobalSkillDirs`, issues);
  optionalStringArray(value, "globalSkillDirs", `${path}.globalSkillDirs`, issues);
  optionalStringArray(value, "workspaceSkillDirs", `${path}.workspaceSkillDirs`, issues);
  optionalStringArray(value, "projectSkillDirs", `${path}.projectSkillDirs`, issues);
  optionalStringArray(value, "globalRuleFiles", `${path}.globalRuleFiles`, issues);
  optionalStringArray(value, "workspaceRuleFiles", `${path}.workspaceRuleFiles`, issues);
  optionalStringArray(value, "projectRuleFiles", `${path}.projectRuleFiles`, issues);
  optionalStringArray(value, "globalRuleDirs", `${path}.globalRuleDirs`, issues);
  optionalStringArray(value, "workspaceRuleDirs", `${path}.workspaceRuleDirs`, issues);
  optionalStringArray(value, "projectRuleDirs", `${path}.projectRuleDirs`, issues);
}

export function validateGetScopedContextMessage(
  input: UnknownRecord
): ProtocolValidationResult<GetScopedContextMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GET_SCOPED_CONTEXT_FIELDS, issues);

  const scope = optionalEnum(input, "scope", "$.scope", SCOPED_CONTEXT_SCOPES, issues);
  const kind = optionalEnum(input, "kind", "$.kind", SCOPED_CONTEXT_KINDS, issues);

  if (issues.length > 0) return invalid("Invalid get-scoped-context message", issues);

  return ok({
    type: "get-scoped-context",
    ...(scope !== undefined ? { scope } : {}),
    ...(kind !== undefined ? { kind } : {}),
  });
}

export function validateUpsertScopedContextMessage(
  input: UnknownRecord
): ProtocolValidationResult<UpsertScopedContextMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, UPSERT_SCOPED_CONTEXT_FIELDS, issues);
  validateScopedContextRecord(input.record, "$.record", issues);

  if (issues.length > 0) return invalid("Invalid upsert-scoped-context message", issues);

  return ok({
    type: "upsert-scoped-context",
    record: input.record as UpsertScopedContextMessage["record"],
  });
}

export function validateDeleteScopedContextMessage(
  input: UnknownRecord
): ProtocolValidationResult<DeleteScopedContextMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, DELETE_SCOPED_CONTEXT_FIELDS, issues);

  const recordId = requiredString(input, "recordId", "$.recordId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid delete-scoped-context message", issues);

  return ok({
    type: "delete-scoped-context",
    recordId: recordId as string,
  });
}

export function validateResolveScopedContextMessage(
  input: UnknownRecord
): ProtocolValidationResult<ResolveScopedContextMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, RESOLVE_SCOPED_CONTEXT_FIELDS, issues);

  const cwd = requiredString(input, "cwd", "$.cwd", issues, { nonEmpty: true });
  const workspaceRoot = optionalString(input, "workspaceRoot", "$.workspaceRoot", issues, {
    nonEmpty: true,
  });
  const projectRoot = optionalString(input, "projectRoot", "$.projectRoot", issues, {
    nonEmpty: true,
  });
  const projectMarkers = optionalStringArray(input, "projectMarkers", "$.projectMarkers", issues);
  const projectFiles = optionalStringArray(input, "projectFiles", "$.projectFiles", issues);
  const projectTags = optionalStringArray(input, "projectTags", "$.projectTags", issues);
  const packageNames = optionalStringArray(input, "packageNames", "$.packageNames", issues);
  const userEnabledIds = optionalStringArray(input, "userEnabledIds", "$.userEnabledIds", issues);
  const userDisabledIds = optionalStringArray(input, "userDisabledIds", "$.userDisabledIds", issues);
  if ("scopedContextConfig" in input) {
    validateScopedContextRuntimeConfig(input.scopedContextConfig, "$.scopedContextConfig", issues);
  }

  if (issues.length > 0) return invalid("Invalid resolve-scoped-context message", issues);

  return ok({
    type: "resolve-scoped-context",
    cwd: cwd as string,
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    ...(projectMarkers !== undefined ? { projectMarkers } : {}),
    ...(projectFiles !== undefined ? { projectFiles } : {}),
    ...(projectTags !== undefined ? { projectTags } : {}),
    ...(packageNames !== undefined ? { packageNames } : {}),
    ...(userEnabledIds !== undefined ? { userEnabledIds } : {}),
    ...(userDisabledIds !== undefined ? { userDisabledIds } : {}),
    ...("scopedContextConfig" in input
      ? { scopedContextConfig: input.scopedContextConfig as ResolveScopedContextMessage["scopedContextConfig"] }
      : {}),
  });
}

export function validateDaemonReadyMessage(
  input: UnknownRecord
): ProtocolValidationResult<DaemonReadyMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, DAEMON_READY_FIELDS, issues);

  const port = requiredInteger(input, "port", "$.port", issues, { min: 0 });
  const protocolVersion = requiredInteger(input, "protocolVersion", "$.protocolVersion", issues, { min: 1 });
  const buildHash = requiredString(input, "buildHash", "$.buildHash", issues);

  if (issues.length > 0) return invalid("Invalid daemon-ready message", issues);

  return ok({
    type: "daemon-ready",
    port: port as number,
    protocolVersion: protocolVersion as number,
    buildHash: buildHash as string,
  });
}

export function validateEventMessage(
  input: UnknownRecord
): ProtocolValidationResult<EventMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, EVENT_FIELDS, issues);

  const runId = requiredString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });
  const orchestratorEventId = optionalString(input, "orchestratorEventId", "$.orchestratorEventId", issues, { nonEmpty: true });
  const sequence = optionalInteger(input, "sequence", "$.sequence", issues, { min: 0 });
  const timestamp = optionalString(input, "timestamp", "$.timestamp", issues, { nonEmpty: true });
  validateAgentEvent(input.event, "$.event", issues);

  if (issues.length > 0) return invalid("Invalid event message", issues);

  return ok({
    type: "event",
    runId: runId as string,
    ...(orchestratorEventId !== undefined ? { orchestratorEventId } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    event: input.event as EventMessage["event"],
  });
}

export function validateApprovalRequestedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ApprovalRequestedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, APPROVAL_REQUESTED_FIELDS, issues);

  const runId = requiredString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });
  const toolCallId = requiredString(
    input,
    "toolCallId",
    "$.toolCallId",
    issues,
    { nonEmpty: true }
  );
  const toolName = requiredString(input, "toolName", "$.toolName", issues, {
    nonEmpty: true,
  });
  const inputObject = requiredRecord(input, "input", "$.input", issues);
  const summary = requiredString(input, "summary", "$.summary", issues);
  const timeoutMs = requiredNullableInteger(
    input,
    "timeoutMs",
    "$.timeoutMs",
    issues,
    { min: 0 }
  );
  const expiresAt = requiredNullableInteger(
    input,
    "expiresAt",
    "$.expiresAt",
    issues,
    { min: 0 }
  );
  const remainingMs = requiredNullableInteger(
    input,
    "remainingMs",
    "$.remainingMs",
    issues,
    { min: 0 }
  );
  const risk = optionalString(input, "risk", "$.risk", issues);
  const riskReason = optionalString(input, "riskReason", "$.riskReason", issues);
  const requiresDoubleConfirm = optionalBoolean(
    input,
    "requiresDoubleConfirm",
    "$.requiresDoubleConfirm",
    issues
  );
  const recommendSnapshot = optionalBoolean(
    input,
    "recommendSnapshot",
    "$.recommendSnapshot",
    issues
  );
  if ("metadata" in input && !isRecord(input.metadata)) {
    issues.push({ path: "$.metadata", message: "Expected object" });
  }

  if (issues.length > 0) {
    return invalid("Invalid approval-requested message", issues);
  }

  return ok({
    type: "approval-requested",
    runId: runId as string,
    toolCallId: toolCallId as string,
    toolName: toolName as string,
    input: inputObject as Record<string, unknown>,
    summary: summary as string,
    timeoutMs: timeoutMs as number | null,
    expiresAt: expiresAt as number | null,
    remainingMs: remainingMs as number | null,
    ...(risk !== undefined ? { risk } : {}),
    ...(riskReason !== undefined ? { riskReason } : {}),
    ...(requiresDoubleConfirm !== undefined ? { requiresDoubleConfirm } : {}),
    ...(recommendSnapshot !== undefined ? { recommendSnapshot } : {}),
    ...(isRecord(input.metadata) ? { metadata: input.metadata as JsonObject } : {}),
  });
}

export function validateApprovalResolvedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ApprovalResolvedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, APPROVAL_RESOLVED_FIELDS, issues);

  const toolCallId = requiredString(
    input,
    "toolCallId",
    "$.toolCallId",
    issues,
    { nonEmpty: true }
  );
  const decision = requiredEnum(
    input,
    "decision",
    "$.decision",
    ["approved", "denied", "expired"],
    issues
  );
  const reason = optionalString(input, "reason", "$.reason", issues);
  const expiredAt = optionalInteger(input, "expiredAt", "$.expiredAt", issues, {
    min: 0,
  });

  if (issues.length > 0) {
    return invalid("Invalid approval-resolved message", issues);
  }

  return ok({
    type: "approval-resolved",
    toolCallId: toolCallId as string,
    decision: decision as ApprovalResolvedMessage["decision"],
    ...(reason !== undefined ? { reason } : {}),
    ...(expiredAt !== undefined ? { expiredAt } : {}),
  });
}

export function validateErrorMessage(
  input: UnknownRecord
): ProtocolValidationResult<ErrorMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, ERROR_FIELDS, issues);

  const code = requiredString(input, "code", "$.code", issues, {
    nonEmpty: true,
  });
  const message = requiredString(input, "message", "$.message", issues);
  const runId = optionalString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid error message", issues);

  return ok({
    type: "error",
    code: code as string,
    message: message as string,
    ...(runId !== undefined ? { runId } : {}),
  });
}

export function validatePongMessage(
  input: UnknownRecord
): ProtocolValidationResult<PongMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, EMPTY_COMMAND_FIELDS, issues);

  if (issues.length > 0) return invalid("Invalid pong message", issues);

  return ok({ type: "pong" });
}

export function validateStatusResponseMessage(
  input: UnknownRecord
): ProtocolValidationResult<StatusResponseMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, STATUS_RESPONSE_FIELDS, issues);

  const lifecycle = requiredRecord(
    input,
    "lifecycle",
    "$.lifecycle",
    issues
  );
  const activeRuns = requiredArray(
    input,
    "activeRuns",
    "$.activeRuns",
    issues
  );
  const pendingApprovals = requiredArray(
    input,
    "pendingApprovals",
    "$.pendingApprovals",
    issues
  );
  const recentApprovals = requiredArray(
    input,
    "recentApprovals",
    "$.recentApprovals",
    issues
  );
  const providerStatus = requiredRecord(
    input,
    "providerStatus",
    "$.providerStatus",
    issues
  );
  const mcpStatus = requiredRecord(
    input,
    "mcpStatus",
    "$.mcpStatus",
    issues
  );
  const capabilities = requiredRecord(
    input,
    "capabilities",
    "$.capabilities",
    issues
  );

  if (lifecycle) {
    validateLifecycleSnapshot(lifecycle, "$.lifecycle", issues);
  }

  if (activeRuns) {
    activeRuns.forEach((run, index) =>
      validateStatusActiveRun(run, `$.activeRuns[${index}]`, issues)
    );
  }

  if (pendingApprovals) {
    pendingApprovals.forEach((approval, index) =>
      validatePendingApproval(
        approval,
        `$.pendingApprovals[${index}]`,
        issues
      )
    );
  }
  if (recentApprovals) {
    recentApprovals.forEach((approval, index) =>
      validatePendingApproval(
        approval,
        `$.recentApprovals[${index}]`,
        issues
      )
    );
  }

  if (providerStatus) {
    validateProviderStatus(providerStatus, "$.providerStatus", issues);
  }
  if (mcpStatus) {
    validateMcpStatus(mcpStatus, "$.mcpStatus", issues);
  }
  if (capabilities) {
    validateCapabilitySnapshot(capabilities, "$.capabilities", issues);
  }

  if (issues.length > 0) return invalid("Invalid status-response message", issues);

  return ok({
    type: "status-response",
    lifecycle: lifecycle as unknown as StatusResponseMessage["lifecycle"],
    activeRuns: activeRuns as StatusResponseMessage["activeRuns"],
    pendingApprovals:
      pendingApprovals as StatusResponseMessage["pendingApprovals"],
    recentApprovals: recentApprovals as StatusResponseMessage["recentApprovals"],
    providerStatus: providerStatus as unknown as StatusResponseMessage["providerStatus"],
    mcpStatus: mcpStatus as unknown as StatusResponseMessage["mcpStatus"],
    capabilities: capabilities as unknown as StatusResponseMessage["capabilities"],
  });
}

export function validateCapabilitiesResponseMessage(
  input: UnknownRecord
): ProtocolValidationResult<CapabilitiesResponseMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CAPABILITIES_RESPONSE_FIELDS, issues);

  const snapshot = requiredRecord(input, "snapshot", "$.snapshot", issues);
  if (snapshot) {
    validateCapabilitySnapshot(snapshot, "$.snapshot", issues);
  }

  if (issues.length > 0) return invalid("Invalid capabilities-response message", issues);

  return ok({
    type: "capabilities-response",
    snapshot: snapshot as unknown as CapabilitiesResponseMessage["snapshot"],
  });
}

export function validateConfigUpdatedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ConfigUpdatedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CONFIG_UPDATED_FIELDS, issues);

  const updatedFields = requiredArray(
    input,
    "updatedFields",
    "$.updatedFields",
    issues
  );
  if (updatedFields) {
    updatedFields.forEach((field, index) => {
      if (typeof field !== "string") {
        issues.push({
          path: `$.updatedFields[${index}]`,
          message: "Expected string",
        });
      }
    });
  }

  if (issues.length > 0) return invalid("Invalid config-updated message", issues);

  return ok({
    type: "config-updated",
    updatedFields: updatedFields as string[],
  });
}

export function validateSubagentStartedMessage(
  input: UnknownRecord
): ProtocolValidationResult<SubagentStartedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SUBAGENT_STARTED_FIELDS, issues);

  const runId = requiredString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });
  const subagentId = requiredString(
    input,
    "subagentId",
    "$.subagentId",
    issues,
    { nonEmpty: true }
  );
  const subagentRunId = requiredString(
    input,
    "subagentRunId",
    "$.subagentRunId",
    issues,
    { nonEmpty: true }
  );
  const parentToolCallId = requiredString(
    input,
    "parentToolCallId",
    "$.parentToolCallId",
    issues,
    { nonEmpty: true }
  );
  const description = requiredString(
    input,
    "description",
    "$.description",
    issues
  );
  const mode = requiredString(input, "mode", "$.mode", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) {
    return invalid("Invalid subagent-started message", issues);
  }

  return ok({
    type: "subagent-started",
    runId: runId as string,
    subagentId: subagentId as string,
    subagentRunId: subagentRunId as string,
    parentToolCallId: parentToolCallId as string,
    description: description as string,
    mode: mode as string,
  });
}

export function validateSubagentEndedMessage(
  input: UnknownRecord
): ProtocolValidationResult<SubagentEndedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SUBAGENT_ENDED_FIELDS, issues);

  const runId = requiredString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });
  const subagentId = requiredString(
    input,
    "subagentId",
    "$.subagentId",
    issues,
    { nonEmpty: true }
  );
  const subagentRunId = requiredString(
    input,
    "subagentRunId",
    "$.subagentRunId",
    issues,
    { nonEmpty: true }
  );
  const parentToolCallId = requiredString(
    input,
    "parentToolCallId",
    "$.parentToolCallId",
    issues,
    { nonEmpty: true }
  );
  const status = requiredEnum(
    input,
    "status",
    "$.status",
    ["completed", "failed"],
    issues
  );
  const summary = requiredString(input, "summary", "$.summary", issues);

  if (issues.length > 0) {
    return invalid("Invalid subagent-ended message", issues);
  }

  return ok({
    type: "subagent-ended",
    runId: runId as string,
    subagentId: subagentId as string,
    subagentRunId: subagentRunId as string,
    parentToolCallId: parentToolCallId as string,
    status: status as "completed" | "failed",
    summary: summary as string,
  });
}

export function validateSubagentEventMessage(
  input: UnknownRecord
): ProtocolValidationResult<SubagentEventMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SUBAGENT_EVENT_FIELDS, issues);

  const runId = requiredString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });
  const subagentId = requiredString(
    input,
    "subagentId",
    "$.subagentId",
    issues,
    { nonEmpty: true }
  );
  const subagentRunId = requiredString(
    input,
    "subagentRunId",
    "$.subagentRunId",
    issues,
    { nonEmpty: true }
  );
  const parentToolCallId = requiredString(
    input,
    "parentToolCallId",
    "$.parentToolCallId",
    issues,
    { nonEmpty: true }
  );
  validateAgentEvent(input.event, "$.event", issues);

  if (issues.length > 0) return invalid("Invalid subagent-event message", issues);

  return ok({
    type: "subagent-event",
    runId: runId as string,
    subagentId: subagentId as string,
    subagentRunId: subagentRunId as string,
    parentToolCallId: parentToolCallId as string,
    event: input.event as SubagentEventMessage["event"],
  });
}

export function validateSessionsListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<SessionsListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SESSIONS_LISTED_FIELDS, issues);

  const sessions = requiredArray(input, "sessions", "$.sessions", issues);
  const summaries = optionalArray(input, "summaries", "$.summaries", issues);
  const eventLog = "eventLog" in input ? requiredEventLogMetadata(input, "eventLog", "$.eventLog", issues) : undefined;
  if ("diagnostics" in input) {
    validateSessionListDiagnostics(input.diagnostics, "$.diagnostics", issues);
  }
  if (sessions) {
    sessions.forEach((session, index) =>
      validateSessionRecord(session, `$.sessions[${index}]`, issues)
    );
  }
  if (summaries) {
    summaries.forEach((summary, index) =>
      validateSessionSummary(summary, `$.summaries[${index}]`, issues)
    );
  }

  if (issues.length > 0) return invalid("Invalid sessions-listed message", issues);

  return ok({
    type: "sessions-listed",
    sessions: sessions as SessionsListedMessage["sessions"],
    ...(summaries !== undefined ? { summaries: summaries as SessionsListedMessage["summaries"] } : {}),
    ...(eventLog !== undefined ? { eventLog } : {}),
    ...("diagnostics" in input ? { diagnostics: input.diagnostics as SessionsListedMessage["diagnostics"] } : {}),
  });
}

export function validateRunsListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<RunsListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, RUNS_LISTED_FIELDS, issues);

  const runs = requiredArray(input, "runs", "$.runs", issues);
  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });
  if (runs) {
    runs.forEach((run, index) =>
      validateRunRecord(run, `$.runs[${index}]`, issues)
    );
  }

  if (issues.length > 0) return invalid("Invalid runs-listed message", issues);

  return ok({
    type: "runs-listed",
    runs: runs as RunsListedMessage["runs"],
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

export function validateSessionEventsMessage(
  input: UnknownRecord
): ProtocolValidationResult<SessionEventsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SESSION_EVENTS_FIELDS, issues);

  const sessionId = requiredString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });
  const events = requiredArray(input, "events", "$.events", issues);
  const eventLog = requiredEventLogMetadata(input, "eventLog", "$.eventLog", issues);
  const cursorDiagnostic = optionalEventCursorDiagnostic(input, "cursorDiagnostic", "$.cursorDiagnostic", issues);
  if ("diagnostics" in input) {
    validateEventReadDiagnostics(input.diagnostics, "$.diagnostics", issues);
  }
  const nextAfterSequence = requiredInteger(
    input,
    "nextAfterSequence",
    "$.nextAfterSequence",
    issues,
    { min: 0 }
  );
  const hasMore = optionalBoolean(input, "hasMore", "$.hasMore", issues);
  const nextCursor = optionalEventReplayCursor(input, "nextCursor", "$.nextCursor", issues);
  const afterSequence = optionalInteger(
    input,
    "afterSequence",
    "$.afterSequence",
    issues,
    { min: 0 }
  );
  const lastEventId = optionalString(input, "lastEventId", "$.lastEventId", issues, {
    nonEmpty: true,
  });

  if (events) {
    events.forEach((event, index) =>
      validateOrchestratorEvent(event, `$.events[${index}]`, issues)
    );
  }

  if (issues.length > 0) return invalid("Invalid session-events message", issues);

  return ok({
    type: "session-events",
    sessionId: sessionId as string,
    events: events as SessionEventsMessage["events"],
    eventLog: eventLog as SessionEventsMessage["eventLog"],
    ...(cursorDiagnostic !== undefined ? { cursorDiagnostic } : {}),
    ...("diagnostics" in input ? { diagnostics: input.diagnostics as SessionEventsMessage["diagnostics"] } : {}),
    nextAfterSequence: nextAfterSequence as number,
    ...(hasMore !== undefined ? { hasMore } : {}),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    ...(afterSequence !== undefined ? { afterSequence } : {}),
    ...(lastEventId !== undefined ? { lastEventId } : {}),
  });
}

export function validateRunEventsMessage(
  input: UnknownRecord
): ProtocolValidationResult<RunEventsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, RUN_EVENTS_FIELDS, issues);

  const runId = requiredString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });
  const events = requiredArray(input, "events", "$.events", issues);
  const eventLog = requiredEventLogMetadata(input, "eventLog", "$.eventLog", issues);
  const cursorDiagnostic = optionalEventCursorDiagnostic(input, "cursorDiagnostic", "$.cursorDiagnostic", issues);
  if ("diagnostics" in input) {
    validateEventReadDiagnostics(input.diagnostics, "$.diagnostics", issues);
  }
  const nextAfterSequence = requiredInteger(
    input,
    "nextAfterSequence",
    "$.nextAfterSequence",
    issues,
    { min: 0 }
  );
  const hasMore = optionalBoolean(input, "hasMore", "$.hasMore", issues);
  const nextCursor = optionalEventReplayCursor(input, "nextCursor", "$.nextCursor", issues);
  const afterSequence = optionalInteger(
    input,
    "afterSequence",
    "$.afterSequence",
    issues,
    { min: 0 }
  );
  const lastEventId = optionalString(input, "lastEventId", "$.lastEventId", issues, {
    nonEmpty: true,
  });

  if (events) {
    events.forEach((event, index) =>
      validateOrchestratorEvent(event, `$.events[${index}]`, issues)
    );
  }
  if ("snapshot" in input) {
    validateTaskSnapshot(input.snapshot, "$.snapshot", issues);
  }

  if (issues.length > 0) return invalid("Invalid run-events message", issues);

  return ok({
    type: "run-events",
    runId: runId as string,
    events: events as RunEventsMessage["events"],
    eventLog: eventLog as RunEventsMessage["eventLog"],
    ...(cursorDiagnostic !== undefined ? { cursorDiagnostic } : {}),
    ...("diagnostics" in input ? { diagnostics: input.diagnostics as RunEventsMessage["diagnostics"] } : {}),
    nextAfterSequence: nextAfterSequence as number,
    ...(hasMore !== undefined ? { hasMore } : {}),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    ...(afterSequence !== undefined ? { afterSequence } : {}),
    ...(lastEventId !== undefined ? { lastEventId } : {}),
    ...("snapshot" in input ? { snapshot: input.snapshot as RunEventsMessage["snapshot"] } : {}),
  });
}

export function validateRunSnapshotMessage(
  input: UnknownRecord
): ProtocolValidationResult<RunSnapshotMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, RUN_SNAPSHOT_FIELDS, issues);

  const runId = requiredString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });
  validateTaskSnapshot(input.snapshot, "$.snapshot", issues);

  if (issues.length > 0) return invalid("Invalid run-snapshot message", issues);

  return ok({
    type: "run-snapshot",
    runId: runId as string,
    snapshot: input.snapshot as RunSnapshotMessage["snapshot"],
  });
}

export function validatePendingInputQueuedMessage(
  input: UnknownRecord
): ProtocolValidationResult<PendingInputQueuedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PENDING_INPUT_QUEUED_FIELDS, issues);
  validatePendingInputRecord(input.input, "$.input", issues);
  validateOrchestratorEvent(input.event, "$.event", issues);

  if (issues.length > 0) return invalid("Invalid pending-input-queued message", issues);

  return ok({
    type: "pending-input-queued",
    input: input.input as PendingInputQueuedMessage["input"],
    event: input.event as PendingInputQueuedMessage["event"],
  });
}

export function validatePendingInputCancelledMessage(
  input: UnknownRecord
): ProtocolValidationResult<PendingInputCancelledMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PENDING_INPUT_CANCELLED_FIELDS, issues);
  validatePendingInputRecord(input.input, "$.input", issues);
  validateOrchestratorEvent(input.event, "$.event", issues);

  if (issues.length > 0) return invalid("Invalid pending-input-cancelled message", issues);

  return ok({
    type: "pending-input-cancelled",
    input: input.input as PendingInputCancelledMessage["input"],
    event: input.event as PendingInputCancelledMessage["event"],
  });
}

export function validatePendingInputDispatchedMessage(
  input: UnknownRecord
): ProtocolValidationResult<PendingInputDispatchedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PENDING_INPUT_DISPATCHED_FIELDS, issues);
  validatePendingInputRecord(input.input, "$.input", issues);
  validateOrchestratorEvent(input.event, "$.event", issues);

  if (issues.length > 0) return invalid("Invalid pending-input-dispatched message", issues);

  return ok({
    type: "pending-input-dispatched",
    input: input.input as PendingInputDispatchedMessage["input"],
    event: input.event as PendingInputDispatchedMessage["event"],
  });
}

export function validatePendingInputsListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<PendingInputsListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PENDING_INPUTS_LISTED_FIELDS, issues);
  const inputs = requiredArray(input, "inputs", "$.inputs", issues);
  inputs?.forEach((record, index) => validatePendingInputRecord(record, `$.inputs[${index}]`, issues));
  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, { nonEmpty: true });

  if (issues.length > 0) return invalid("Invalid pending-inputs-listed message", issues);

  return ok({
    type: "pending-inputs-listed",
    inputs: inputs as PendingInputsListedMessage["inputs"],
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

export function validateWorkflowsListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<WorkflowsListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, WORKFLOWS_LISTED_FIELDS, issues);

  const workflows = requiredArray(input, "workflows", "$.workflows", issues);
  workflows?.forEach((workflow, index) =>
    validateWorkflowDefinition(workflow, `$.workflows[${index}]`, issues)
  );

  if (issues.length > 0) return invalid("Invalid workflows-listed message", issues);

  return ok({
    type: "workflows-listed",
    workflows: workflows as WorkflowsListedMessage["workflows"],
  });
}

export function validateWorkflowCreatedMessage(
  input: UnknownRecord
): ProtocolValidationResult<WorkflowCreatedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, WORKFLOW_CREATED_FIELDS, issues);
  validateWorkflowDefinition(input.workflow, "$.workflow", issues);

  if (issues.length > 0) return invalid("Invalid workflow-created message", issues);

  return ok({
    type: "workflow-created",
    workflow: input.workflow as WorkflowCreatedMessage["workflow"],
  });
}

export function validateWorkflowUpdatedMessage(
  input: UnknownRecord
): ProtocolValidationResult<WorkflowUpdatedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, WORKFLOW_UPDATED_FIELDS, issues);
  validateWorkflowDefinition(input.workflow, "$.workflow", issues);

  if (issues.length > 0) return invalid("Invalid workflow-updated message", issues);

  return ok({
    type: "workflow-updated",
    workflow: input.workflow as WorkflowUpdatedMessage["workflow"],
  });
}

export function validateWorkflowDeletedMessage(
  input: UnknownRecord
): ProtocolValidationResult<WorkflowDeletedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, WORKFLOW_DELETED_FIELDS, issues);
  const workflowId = requiredString(input, "workflowId", "$.workflowId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid workflow-deleted message", issues);

  return ok({
    type: "workflow-deleted",
    workflowId: workflowId as string,
  });
}

export function validateWorkflowTriggeredMessage(
  input: UnknownRecord
): ProtocolValidationResult<WorkflowTriggeredMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, WORKFLOW_TRIGGERED_FIELDS, issues);
  requiredBoolean(input, "accepted", "$.accepted", issues);
  requiredString(input, "runId", "$.runId", issues, { nonEmpty: true });
  requiredString(input, "workflowRunId", "$.workflowRunId", issues, { nonEmpty: true });
  validateWorkflowRunEntry(input.run, "$.run", issues);

  if (issues.length > 0) return invalid("Invalid workflow-triggered message", issues);

  return ok({
    type: "workflow-triggered",
    accepted: true,
    runId: input.runId as string,
    workflowRunId: input.workflowRunId as string,
    run: input.run as WorkflowTriggeredMessage["run"],
  });
}

export function validateWorkflowRunUpdatedMessage(
  input: UnknownRecord
): ProtocolValidationResult<WorkflowRunUpdatedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, WORKFLOW_RUN_UPDATED_FIELDS, issues);
  requiredString(input, "runId", "$.runId", issues, { nonEmpty: true });
  requiredString(input, "workflowRunId", "$.workflowRunId", issues, { nonEmpty: true });
  requiredString(input, "workflowId", "$.workflowId", issues, { nonEmpty: true });
  validateWorkflowRunEntry(input.run, "$.run", issues);

  if (issues.length > 0) return invalid("Invalid workflow-run-updated message", issues);

  return ok({
    type: "workflow-run-updated",
    runId: input.runId as string,
    workflowRunId: input.workflowRunId as string,
    workflowId: input.workflowId as string,
    run: input.run as WorkflowRunUpdatedMessage["run"],
  });
}

export function validateWorkflowRunsListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<WorkflowRunsListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, WORKFLOW_RUNS_LISTED_FIELDS, issues);

  const runs = requiredArray(input, "runs", "$.runs", issues);
  const workflowId = optionalString(input, "workflowId", "$.workflowId", issues, {
    nonEmpty: true,
  });
  runs?.forEach((run, index) =>
    validateWorkflowRunEntry(run, `$.runs[${index}]`, issues)
  );

  if (issues.length > 0) return invalid("Invalid workflow-runs-listed message", issues);

  return ok({
    type: "workflow-runs-listed",
    runs: runs as WorkflowRunsListedMessage["runs"],
    ...(workflowId !== undefined ? { workflowId } : {}),
  });
}

export function validateGitStatusResponseMessage(
  input: UnknownRecord
): ProtocolValidationResult<GitStatusResponseMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GIT_STATUS_RESPONSE_FIELDS, issues);

  const cwd = requiredString(input, "cwd", "$.cwd", issues, { nonEmpty: true });
  const found = requiredBoolean(input, "found", "$.found", issues);
  const repositoryRoot = optionalString(input, "repositoryRoot", "$.repositoryRoot", issues, { nonEmpty: true });
  const gitDir = optionalString(input, "gitDir", "$.gitDir", issues, { nonEmpty: true });
  validateOptionalNullableString(input, "head", "$.head", issues);
  validateOptionalNullableString(input, "branch", "$.branch", issues);
  const clean = optionalBoolean(input, "clean", "$.clean", issues);
  const files = requiredArray(input, "files", "$.files", issues);
  files?.forEach((file, index) => validateGitStatusFile(file, `$.files[${index}]`, issues));
  const stagedCount = requiredInteger(input, "stagedCount", "$.stagedCount", issues, { min: 0 });
  const unstagedCount = requiredInteger(input, "unstagedCount", "$.unstagedCount", issues, { min: 0 });
  const untrackedCount = requiredInteger(input, "untrackedCount", "$.untrackedCount", issues, { min: 0 });
  const conflictedCount = requiredInteger(input, "conflictedCount", "$.conflictedCount", issues, { min: 0 });
  const reason = optionalString(input, "reason", "$.reason", issues, { nonEmpty: true });

  if (issues.length > 0) return invalid("Invalid git-status-response message", issues);

  return ok({
    type: "git-status-response",
    cwd: cwd as string,
    found: found as boolean,
    ...(repositoryRoot !== undefined ? { repositoryRoot } : {}),
    ...(gitDir !== undefined ? { gitDir } : {}),
    ...("head" in input ? { head: input.head as string | null } : {}),
    ...("branch" in input ? { branch: input.branch as string | null } : {}),
    ...(clean !== undefined ? { clean } : {}),
    files: files as GitStatusResponseMessage["files"],
    stagedCount: stagedCount as number,
    unstagedCount: unstagedCount as number,
    untrackedCount: untrackedCount as number,
    conflictedCount: conflictedCount as number,
    ...(reason !== undefined ? { reason } : {}),
  });
}

export function validateGitDiffResponseMessage(
  input: UnknownRecord
): ProtocolValidationResult<GitDiffResponseMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GIT_DIFF_RESPONSE_FIELDS, issues);

  const cwd = requiredString(input, "cwd", "$.cwd", issues, { nonEmpty: true });
  const repositoryRoot = optionalString(input, "repositoryRoot", "$.repositoryRoot", issues, { nonEmpty: true });
  const path = optionalString(input, "path", "$.path", issues, { nonEmpty: true });
  const staged = requiredBoolean(input, "staged", "$.staged", issues);
  const unified = requiredString(input, "unified", "$.unified", issues);
  const stat = requiredString(input, "stat", "$.stat", issues);
  const files = requiredArray(input, "files", "$.files", issues);
  files?.forEach((file, index) => validateChangedFileRecord(file, `$.files[${index}]`, issues));

  if (issues.length > 0) return invalid("Invalid git-diff-response message", issues);

  return ok({
    type: "git-diff-response",
    cwd: cwd as string,
    ...(repositoryRoot !== undefined ? { repositoryRoot } : {}),
    ...(path !== undefined ? { path } : {}),
    staged: staged as boolean,
    unified: unified as string,
    stat: stat as string,
    files: files as GitDiffResponseMessage["files"],
  });
}

export function validatePlanDocumentsListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<PlanDocumentsListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PLAN_DOCUMENTS_LISTED_FIELDS, issues);

  const documents = requiredArray(input, "documents", "$.documents", issues);
  documents?.forEach((document, index) =>
    validatePlanDocumentSummary(document, `$.documents[${index}]`, issues)
  );

  if (issues.length > 0) return invalid("Invalid plan-documents-listed message", issues);

  return ok({
    type: "plan-documents-listed",
    documents: documents as PlanDocumentsListedMessage["documents"],
  });
}

export function validatePlanDocumentCreatedMessage(
  input: UnknownRecord
): ProtocolValidationResult<PlanDocumentCreatedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PLAN_DOCUMENT_MESSAGE_FIELDS, issues);
  validatePlanDocumentPayload(input.document, "$.document", issues);

  if (issues.length > 0) return invalid("Invalid plan-document-created message", issues);

  return ok({
    type: "plan-document-created",
    document: input.document as PlanDocumentCreatedMessage["document"],
  });
}

export function validatePlanDocumentMessage(
  input: UnknownRecord
): ProtocolValidationResult<PlanDocumentMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PLAN_DOCUMENT_MESSAGE_FIELDS, issues);
  validatePlanDocumentPayload(input.document, "$.document", issues);

  if (issues.length > 0) return invalid("Invalid plan-document message", issues);

  return ok({
    type: "plan-document",
    document: input.document as PlanDocumentMessage["document"],
  });
}

export function validatePlanDocumentPatchedMessage(
  input: UnknownRecord
): ProtocolValidationResult<PlanDocumentPatchedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PLAN_DOCUMENT_MESSAGE_FIELDS, issues);
  validatePlanDocumentPayload(input.document, "$.document", issues);

  if (issues.length > 0) return invalid("Invalid plan-document-patched message", issues);

  return ok({
    type: "plan-document-patched",
    document: input.document as PlanDocumentPatchedMessage["document"],
  });
}

export function validatePlanDocumentDeletedMessage(
  input: UnknownRecord
): ProtocolValidationResult<PlanDocumentDeletedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PLAN_DOCUMENT_DELETED_FIELDS, issues);
  const documentId = requiredString(input, "documentId", "$.documentId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid plan-document-deleted message", issues);

  return ok({
    type: "plan-document-deleted",
    documentId: documentId as string,
  });
}

export function validateMutationLeasesListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<MutationLeasesListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, MUTATION_LEASES_LISTED_FIELDS, issues);

  const leases = requiredArray(input, "leases", "$.leases", issues);
  leases?.forEach((lease, index) => validateMutationLeaseSnapshot(lease, `$.leases[${index}]`, issues));

  if (issues.length > 0) return invalid("Invalid mutation-leases-listed message", issues);

  return ok({
    type: "mutation-leases-listed",
    leases: leases as MutationLeasesListedMessage["leases"],
  });
}

export function validateBackgroundTasksListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<BackgroundTasksListedMessage> {
  const issues = validateBackgroundTaskListResponse(input, BACKGROUND_TASKS_LISTED_FIELDS);
  if (issues.length > 0) return invalid("Invalid background-tasks-listed message", issues);
  return ok({
    type: "background-tasks-listed",
    tasks: input.tasks as BackgroundTasksListedMessage["tasks"],
    diagnostics: input.diagnostics as BackgroundTasksListedMessage["diagnostics"],
  });
}

export function validateBackgroundTaskHistoryMessage(
  input: UnknownRecord
): ProtocolValidationResult<BackgroundTaskHistoryMessage> {
  const issues = validateBackgroundTaskListResponse(input, BACKGROUND_TASKS_LISTED_FIELDS);
  if (issues.length > 0) return invalid("Invalid background-task-history message", issues);
  return ok({
    type: "background-task-history",
    tasks: input.tasks as BackgroundTaskHistoryMessage["tasks"],
    diagnostics: input.diagnostics as BackgroundTaskHistoryMessage["diagnostics"],
  });
}

export function validateBackgroundTaskStartedMessage(
  input: UnknownRecord
): ProtocolValidationResult<BackgroundTaskStartedMessage> {
  const issues = validateBackgroundTaskSingleResponse(input);
  if (issues.length > 0) return invalid("Invalid background-task-started message", issues);
  return ok({
    type: "background-task-started",
    task: input.task as BackgroundTaskStartedMessage["task"],
    diagnostics: input.diagnostics as BackgroundTaskStartedMessage["diagnostics"],
  });
}

export function validateBackgroundTaskCancelledMessage(
  input: UnknownRecord
): ProtocolValidationResult<BackgroundTaskCancelledMessage> {
  const issues = validateBackgroundTaskSingleResponse(input);
  if (issues.length > 0) return invalid("Invalid background-task-cancelled message", issues);
  return ok({
    type: "background-task-cancelled",
    task: input.task as BackgroundTaskCancelledMessage["task"],
    diagnostics: input.diagnostics as BackgroundTaskCancelledMessage["diagnostics"],
  });
}

export function validateBackgroundTaskListResponse(
  input: UnknownRecord,
  fields: readonly string[]
): ProtocolValidationIssue[] {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, fields, issues);

  const tasks = requiredArray(input, "tasks", "$.tasks", issues);
  tasks?.forEach((task, index) => validateBackgroundTaskSnapshot(task, `$.tasks[${index}]`, issues));

  const diagnostics = requiredArray(input, "diagnostics", "$.diagnostics", issues);
  diagnostics?.forEach((diagnostic, index) =>
    validateBackgroundTaskDiagnostic(diagnostic, `$.diagnostics[${index}]`, issues)
  );

  return issues;
}

export function validateBackgroundTaskSingleResponse(input: UnknownRecord): ProtocolValidationIssue[] {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, BACKGROUND_TASK_SINGLE_FIELDS, issues);

  validateBackgroundTaskSnapshot(input.task, "$.task", issues);

  const diagnostics = requiredArray(input, "diagnostics", "$.diagnostics", issues);
  diagnostics?.forEach((diagnostic, index) =>
    validateBackgroundTaskDiagnostic(diagnostic, `$.diagnostics[${index}]`, issues)
  );

  return issues;
}

export function validateBackgroundTaskSnapshot(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, BACKGROUND_TASK_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "kind", `${path}.kind`, ["command"], issues);
  requiredString(value, "title", `${path}.title`, issues);
  requiredEnum(value, "state", `${path}.state`, BACKGROUND_TASK_STATES, issues);
  requiredString(value, "command", `${path}.command`, issues);
  if ("cwd" in value) optionalString(value, "cwd", `${path}.cwd`, issues);
  if ("startedAt" in value) optionalString(value, "startedAt", `${path}.startedAt`, issues);
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  if ("finishedAt" in value) optionalString(value, "finishedAt", `${path}.finishedAt`, issues);
  if ("durationMs" in value) optionalNumber(value, "durationMs", `${path}.durationMs`, issues, { min: 0 });
  if ("timeoutMs" in value) optionalNumber(value, "timeoutMs", `${path}.timeoutMs`, issues, { min: 1 });
  if ("exitCode" in value) optionalNullableNumber(value, "exitCode", `${path}.exitCode`, issues);
  if ("signal" in value) optionalNullableString(value, "signal", `${path}.signal`, issues);
  if ("timedOut" in value) optionalBoolean(value, "timedOut", `${path}.timedOut`, issues);
  if ("cancelled" in value) optionalBoolean(value, "cancelled", `${path}.cancelled`, issues);
  if ("truncated" in value) optionalBoolean(value, "truncated", `${path}.truncated`, issues);
  if ("stdoutBytes" in value) optionalInteger(value, "stdoutBytes", `${path}.stdoutBytes`, issues, { min: 0 });
  if ("stderrBytes" in value) optionalInteger(value, "stderrBytes", `${path}.stderrBytes`, issues, { min: 0 });
  if ("outputPreview" in value) optionalString(value, "outputPreview", `${path}.outputPreview`, issues);
  if ("diagnostics" in value) {
    const diagnostics = requiredArray(value, "diagnostics", `${path}.diagnostics`, issues);
    diagnostics?.forEach((diagnostic, index) =>
      validateBackgroundTaskDiagnostic(diagnostic, `${path}.diagnostics[${index}]`, issues)
    );
  }
}

export function validateBackgroundTaskDiagnostic(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, BACKGROUND_TASK_DIAGNOSTIC_FIELDS, issues, path);
  requiredString(value, "code", `${path}.code`, issues, { nonEmpty: true });
  requiredString(value, "message", `${path}.message`, issues, { nonEmpty: true });
  requiredEnum(value, "severity", `${path}.severity`, ["info", "warning", "error"], issues);
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  if ("detail" in value) optionalString(value, "detail", `${path}.detail`, issues);
  if ("metadata" in value && !isRecord(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}

export function validateArtifactsListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ArtifactsListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, ARTIFACTS_LISTED_FIELDS, issues);

  const artifacts = requiredArray(input, "artifacts", "$.artifacts", issues);
  artifacts?.forEach((artifact, index) =>
    validateArtifactRecord(artifact, `$.artifacts[${index}]`, issues)
  );

  if (issues.length > 0) return invalid("Invalid artifacts-listed message", issues);

  return ok({
    type: "artifacts-listed",
    artifacts: artifacts as ArtifactsListedMessage["artifacts"],
  });
}

export function validateArtifactContentMessage(
  input: UnknownRecord
): ProtocolValidationResult<ArtifactContentMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, ARTIFACT_CONTENT_FIELDS, issues);

  const artifactUri = requiredString(input, "artifactUri", "$.artifactUri", issues, {
    nonEmpty: true,
  });
  const content = requiredString(input, "content", "$.content", issues);
  const mimeType = optionalString(input, "mimeType", "$.mimeType", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid artifact-content message", issues);

  return ok({
    type: "artifact-content",
    artifactUri: artifactUri as string,
    content: content as string,
    ...(mimeType !== undefined ? { mimeType } : {}),
  });
}

export function validateMemoriesListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<MemoriesListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, MEMORIES_LISTED_FIELDS, issues);

  const memories = requiredArray(input, "memories", "$.memories", issues);
  memories?.forEach((memory, index) =>
    validateMemoryRecord(memory, `$.memories[${index}]`, issues)
  );

  if (issues.length > 0) return invalid("Invalid memories-listed message", issues);

  return ok({
    type: "memories-listed",
    memories: memories as MemoriesListedMessage["memories"],
  });
}

export function validateMemoryDeletedMessage(
  input: UnknownRecord
): ProtocolValidationResult<MemoryDeletedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, MEMORY_DELETED_FIELDS, issues);

  const memoryId = requiredString(input, "memoryId", "$.memoryId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid memory-deleted message", issues);

  return ok({
    type: "memory-deleted",
    memoryId: memoryId as string,
  });
}

export function validateCheckpointsListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<CheckpointsListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CHECKPOINTS_LISTED_FIELDS, issues);

  const checkpoints = requiredArray(input, "checkpoints", "$.checkpoints", issues);
  checkpoints?.forEach((checkpoint, index) =>
    validateCheckpointRecord(checkpoint, `$.checkpoints[${index}]`, issues)
  );

  if (issues.length > 0) return invalid("Invalid checkpoints-listed message", issues);

  return ok({
    type: "checkpoints-listed",
    checkpoints: checkpoints as CheckpointsListedMessage["checkpoints"],
  });
}

export function validateCheckpointDiffMessage(
  input: UnknownRecord
): ProtocolValidationResult<CheckpointDiffMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CHECKPOINT_DIFF_FIELDS, issues);

  const checkpointId = requiredString(input, "checkpointId", "$.checkpointId", issues, {
    nonEmpty: true,
  });
  const files = requiredArray(input, "files", "$.files", issues);
  files?.forEach((file, index) =>
    validateChangedFileRecord(file, `$.files[${index}]`, issues)
  );

  if (issues.length > 0) return invalid("Invalid checkpoint-diff message", issues);

  return ok({
    type: "checkpoint-diff",
    checkpointId: checkpointId as string,
    files: files as CheckpointDiffMessage["files"],
  });
}

export function validateCheckpointRestoredMessage(
  input: UnknownRecord
): ProtocolValidationResult<CheckpointRestoredMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CHECKPOINT_RESTORED_FIELDS, issues);

  const checkpointId = requiredString(input, "checkpointId", "$.checkpointId", issues, {
    nonEmpty: true,
  });
  const runId = requiredString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid checkpoint-restored message", issues);

  return ok({
    type: "checkpoint-restored",
    checkpointId: checkpointId as string,
    runId: runId as string,
  });
}

export function validateSubagentMessageSentMessage(
  input: UnknownRecord
): ProtocolValidationResult<SubagentMessageSentMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SUBAGENT_MESSAGE_SENT_FIELDS, issues);

  const subagentRunId = requiredString(input, "subagentRunId", "$.subagentRunId", issues, {
    nonEmpty: true,
  });
  const accepted = requiredBoolean(input, "accepted", "$.accepted", issues);

  if (issues.length > 0) return invalid("Invalid subagent-message-sent message", issues);

  return ok({
    type: "subagent-message-sent",
    subagentRunId: subagentRunId as string,
    accepted: accepted as boolean,
  });
}

export function validateSubagentStatusMessage(
  input: UnknownRecord
): ProtocolValidationResult<SubagentStatusMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SUBAGENT_STATUS_FIELDS, issues);

  const subagentRunId = requiredString(input, "subagentRunId", "$.subagentRunId", issues, {
    nonEmpty: true,
  });
  const status = requiredString(input, "status", "$.status", issues, {
    nonEmpty: true,
  });
  const progress = optionalString(input, "progress", "$.progress", issues);
  const latestError = optionalString(input, "latestError", "$.latestError", issues);

  if (issues.length > 0) return invalid("Invalid subagent-status message", issues);

  return ok({
    type: "subagent-status",
    subagentRunId: subagentRunId as string,
    status: status as string,
    ...(progress !== undefined ? { progress } : {}),
    ...(latestError !== undefined ? { latestError } : {}),
  });
}

export function validateMcpServersListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<McpServersListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, MCP_SERVERS_LISTED_FIELDS, issues);

  const servers = requiredArray(input, "servers", "$.servers", issues);
  servers?.forEach((server, index) =>
    validateMcpServerRecord(server, `$.servers[${index}]`, issues)
  );

  if (issues.length > 0) return invalid("Invalid mcp-servers-listed message", issues);

  return ok({
    type: "mcp-servers-listed",
    servers: servers as McpServersListedMessage["servers"],
  });
}

export function validateMcpServerStartedMessage(
  input: UnknownRecord
): ProtocolValidationResult<McpServerStartedMessage> {
  return validateMcpServerStateMessage(input, "mcp-server-started");
}

export function validateMcpServerStoppedMessage(
  input: UnknownRecord
): ProtocolValidationResult<McpServerStoppedMessage> {
  return validateMcpServerStateMessage(input, "mcp-server-stopped");
}

export function validateMcpServerStateMessage<TType extends "mcp-server-started" | "mcp-server-stopped">(
  input: UnknownRecord,
  type: TType
): ProtocolValidationResult<TType extends "mcp-server-started" ? McpServerStartedMessage : McpServerStoppedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(
    input,
    type === "mcp-server-started" ? MCP_SERVER_STARTED_FIELDS : MCP_SERVER_STOPPED_FIELDS,
    issues
  );

  const serverId = requiredString(input, "serverId", "$.serverId", issues, {
    nonEmpty: true,
  });
  const state = requiredString(input, "state", "$.state", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid(`Invalid ${type} message`, issues);

  return ok({
    type,
    serverId: serverId as string,
    state: state as string,
  } as TType extends "mcp-server-started" ? McpServerStartedMessage : McpServerStoppedMessage);
}

export function validateScopedContextResponseMessage(
  input: UnknownRecord
): ProtocolValidationResult<ScopedContextResponseMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SCOPED_CONTEXT_RESPONSE_FIELDS, issues);
  const status = requiredEnum(input, "status", "$.status", SCOPED_CONTEXT_STORE_STATUSES, issues);
  const records = requiredArray(input, "records", "$.records", issues);
  records?.forEach((record, index) =>
    validateScopedContextRecord(record, `$.records[${index}]`, issues)
  );
  if ("diagnostic" in input) {
    validateScopedContextStoreDiagnostic(input.diagnostic, "$.diagnostic", issues);
  }

  if (issues.length > 0) return invalid("Invalid scoped-context-response message", issues);

  return ok({
    type: "scoped-context-response",
    status: status as ScopedContextResponseMessage["status"],
    records: records as ScopedContextResponseMessage["records"],
    ...("diagnostic" in input ? { diagnostic: input.diagnostic as ScopedContextResponseMessage["diagnostic"] } : {}),
  });
}

export function validateScopedContextUpsertedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ScopedContextUpsertedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SCOPED_CONTEXT_UPSERTED_FIELDS, issues);
  const status = requiredEnum(input, "status", "$.status", SCOPED_CONTEXT_STORE_STATUSES, issues);
  validateScopedContextRecord(input.record, "$.record", issues);
  const persisted = requiredBoolean(input, "persisted", "$.persisted", issues);
  if ("diagnostic" in input) {
    validateScopedContextStoreDiagnostic(input.diagnostic, "$.diagnostic", issues);
  }

  if (issues.length > 0) return invalid("Invalid scoped-context-upserted message", issues);

  return ok({
    type: "scoped-context-upserted",
    status: status as ScopedContextUpsertedMessage["status"],
    record: input.record as ScopedContextUpsertedMessage["record"],
    persisted: persisted as boolean,
    ...("diagnostic" in input ? { diagnostic: input.diagnostic as ScopedContextUpsertedMessage["diagnostic"] } : {}),
  });
}

export function validateScopedContextDeletedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ScopedContextDeletedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SCOPED_CONTEXT_DELETED_FIELDS, issues);
  const status = requiredEnum(input, "status", "$.status", SCOPED_CONTEXT_STORE_STATUSES, issues);
  const recordId = requiredString(input, "recordId", "$.recordId", issues, {
    nonEmpty: true,
  });
  const deleted = requiredBoolean(input, "deleted", "$.deleted", issues);
  if ("diagnostic" in input) {
    validateScopedContextStoreDiagnostic(input.diagnostic, "$.diagnostic", issues);
  }

  if (issues.length > 0) return invalid("Invalid scoped-context-deleted message", issues);

  return ok({
    type: "scoped-context-deleted",
    status: status as ScopedContextDeletedMessage["status"],
    recordId: recordId as string,
    deleted: deleted as boolean,
    ...("diagnostic" in input ? { diagnostic: input.diagnostic as ScopedContextDeletedMessage["diagnostic"] } : {}),
  });
}

export function validateScopedContextResolvedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ScopedContextResolvedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SCOPED_CONTEXT_RESOLVED_FIELDS, issues);
  const status = requiredEnum(input, "status", "$.status", SCOPED_CONTEXT_STORE_STATUSES, issues);
  const stableContext = requiredArray(input, "stableContext", "$.stableContext", issues);
  stableContext?.forEach((block, index) =>
    validatePromptContextBlock(block, `$.stableContext[${index}]`, issues)
  );
  const recommended = requiredArray(input, "recommended", "$.recommended", issues);
  recommended?.forEach((candidate, index) =>
    validateScopedContextCandidate(candidate, `$.recommended[${index}]`, issues)
  );
  const items = requiredArray(input, "items", "$.items", issues);
  items?.forEach((item, index) =>
    validateScopedContextResolvedItem(item, `$.items[${index}]`, issues)
  );
  const diagnostics = requiredArray(input, "diagnostics", "$.diagnostics", issues);
  diagnostics?.forEach((diagnostic, index) =>
    validateScopedContextResolverDiagnostic(diagnostic, `$.diagnostics[${index}]`, issues)
  );
  const stableContextHash = requiredString(input, "stableContextHash", "$.stableContextHash", issues, {
    nonEmpty: true,
  });
  const storeRecordCount = requiredInteger(input, "storeRecordCount", "$.storeRecordCount", issues, { min: 0 });
  const resourceRecordCount = requiredInteger(input, "resourceRecordCount", "$.resourceRecordCount", issues, { min: 0 });
  const resourceDiagnostics = requiredArray(input, "resourceDiagnostics", "$.resourceDiagnostics", issues);
  resourceDiagnostics?.forEach((diagnostic, index) =>
    validateScopedContextResourceDiagnostic(diagnostic, `$.resourceDiagnostics[${index}]`, issues)
  );
  if ("storeDiagnostic" in input) {
    validateScopedContextStoreDiagnostic(input.storeDiagnostic, "$.storeDiagnostic", issues);
  }

  if (issues.length > 0) return invalid("Invalid scoped-context-resolved message", issues);

  return ok({
    type: "scoped-context-resolved",
    status: status as ScopedContextResolvedMessage["status"],
    stableContext: stableContext as ScopedContextResolvedMessage["stableContext"],
    recommended: recommended as ScopedContextResolvedMessage["recommended"],
    items: items as ScopedContextResolvedMessage["items"],
    diagnostics: diagnostics as ScopedContextResolvedMessage["diagnostics"],
    stableContextHash: stableContextHash as string,
    storeRecordCount: storeRecordCount as number,
    resourceRecordCount: resourceRecordCount as number,
    resourceDiagnostics: resourceDiagnostics as ScopedContextResolvedMessage["resourceDiagnostics"],
    ...("storeDiagnostic" in input ? { storeDiagnostic: input.storeDiagnostic as ScopedContextResolvedMessage["storeDiagnostic"] } : {}),
  });
}

export function validateConversationRewindPreviewMessage(
  input: UnknownRecord
): ProtocolValidationResult<ConversationRewindPreviewMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CONVERSATION_REWIND_PREVIEW_FIELDS, issues);

  const sessionId = requiredString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });
  validateConversationRewindPlan(input.plan, "$.plan", issues);

  if (issues.length > 0) return invalid("Invalid conversation-rewind-preview message", issues);

  return ok({
    type: "conversation-rewind-preview",
    sessionId: sessionId as string,
    plan: input.plan as ConversationRewindPreviewMessage["plan"],
  });
}

export function validateConversationRewindBoundaryMessage(
  input: UnknownRecord
): ProtocolValidationResult<ConversationRewindBoundaryMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CONVERSATION_REWIND_BOUNDARY_FIELDS, issues);

  const status = requiredEnum(input, "status", "$.status", ["ok", "blocked"], issues);
  const sessionId = requiredString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });
  if ("userMessageId" in input) {
    optionalString(input, "userMessageId", "$.userMessageId", issues, { nonEmpty: true });
  }
  const latestUserMessage = requiredBoolean(input, "latestUserMessage", "$.latestUserMessage", issues);
  const mode = requiredEnum(
    input,
    "mode",
    "$.mode",
    ["keep-user-message", "remove-user-message"],
    issues
  );
  if ("boundary" in input) validateConversationRewindBoundaryRecord(input.boundary, "$.boundary", issues);
  if ("checkpoint" in input) validateConversationRewindCheckpointRecord(input.checkpoint, "$.checkpoint", issues);
  if ("target" in input) validateConversationRewindTargetFacts(input.target, "$.target", issues);
  const missingFacts = requiredArray(input, "missingFacts", "$.missingFacts", issues);
  missingFacts?.forEach((fact, index) => validateConversationRewindMissingFact(fact, `$.missingFacts[${index}]`, issues));
  const diagnostics = requiredArray(input, "diagnostics", "$.diagnostics", issues);
  diagnostics?.forEach((diagnostic, index) =>
    validateConversationRewindBoundaryDiagnostic(diagnostic, `$.diagnostics[${index}]`, issues)
  );
  if ("plan" in input) validateConversationRewindPlan(input.plan, "$.plan", issues);
  if ("runtimeTargetLeafId" in input) {
    optionalString(input, "runtimeTargetLeafId", "$.runtimeTargetLeafId", issues, { nonEmpty: true });
  }

  if (issues.length > 0) return invalid("Invalid conversation-rewind-boundary message", issues);

  return ok({
    type: "conversation-rewind-boundary",
    status: status as ConversationRewindBoundaryMessage["status"],
    sessionId: sessionId as string,
    ...("userMessageId" in input ? { userMessageId: input.userMessageId as string } : {}),
    latestUserMessage: latestUserMessage as boolean,
    mode: mode as ConversationRewindBoundaryMessage["mode"],
    ...("boundary" in input ? { boundary: input.boundary as ConversationRewindBoundaryMessage["boundary"] } : {}),
    ...("checkpoint" in input ? { checkpoint: input.checkpoint as ConversationRewindBoundaryMessage["checkpoint"] } : {}),
    ...("target" in input ? { target: input.target as ConversationRewindBoundaryMessage["target"] } : {}),
    missingFacts: missingFacts as ConversationRewindBoundaryMessage["missingFacts"],
    diagnostics: diagnostics as ConversationRewindBoundaryMessage["diagnostics"],
    ...("plan" in input ? { plan: input.plan as ConversationRewindBoundaryMessage["plan"] } : {}),
    ...("runtimeTargetLeafId" in input ? { runtimeTargetLeafId: input.runtimeTargetLeafId as string } : {}),
  });
}

export function validateConversationRewindAppliedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ConversationRewindAppliedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CONVERSATION_REWIND_APPLIED_FIELDS, issues);

  const sessionId = requiredString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });
  validateConversationRewindPlan(input.plan, "$.plan", issues);
  const stepResults = requiredArray(input, "stepResults", "$.stepResults", issues);
  stepResults?.forEach((result, index) =>
    validateConversationRewindStepResult(result, `$.stepResults[${index}]`, issues)
  );

  if (issues.length > 0) return invalid("Invalid conversation-rewind-applied message", issues);

  return ok({
    type: "conversation-rewind-applied",
    sessionId: sessionId as string,
    plan: input.plan as ConversationRewindAppliedMessage["plan"],
    stepResults: stepResults as ConversationRewindAppliedMessage["stepResults"],
  });
}

export function validateSessionActionReceiptMessage(
  input: UnknownRecord
): ProtocolValidationResult<SessionActionReceiptMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SESSION_ACTION_RECEIPT_FIELDS, issues);

  const protocolVersion = requiredInteger(input, "protocolVersion", "$.protocolVersion", issues, { min: 1 });
  if (protocolVersion !== undefined && protocolVersion !== SESSION_ACTION_PROTOCOL_VERSION) {
    issues.push({
      path: "$.protocolVersion",
      message: `Expected session action protocol version ${SESSION_ACTION_PROTOCOL_VERSION}`,
    });
  }
  const actionId = requiredString(input, "actionId", "$.actionId", issues, { nonEmpty: true });
  const kind = requiredEnum(input, "kind", "$.kind", SESSION_ACTION_KINDS, issues);
  const sessionId = requiredString(input, "sessionId", "$.sessionId", issues, { nonEmpty: true });
  const status = requiredEnum(input, "status", "$.status", SESSION_ACTION_STATUSES, issues);
  const committedAt = optionalString(input, "committedAt", "$.committedAt", issues, { nonEmpty: true });
  const resultingSessionId = optionalString(input, "resultingSessionId", "$.resultingSessionId", issues, {
    nonEmpty: true,
  });
  const resultingEventId = optionalString(input, "resultingEventId", "$.resultingEventId", issues, {
    nonEmpty: true,
  });
  const resultingWorkspaceVersionId = optionalString(
    input,
    "resultingWorkspaceVersionId",
    "$.resultingWorkspaceVersionId",
    issues,
    { nonEmpty: true }
  );
  const errorCode = optionalString(input, "errorCode", "$.errorCode", issues, { nonEmpty: true });
  const errorMessage = optionalString(input, "errorMessage", "$.errorMessage", issues, { nonEmpty: true });

  if ((status === "rejected" || status === "failed") && (errorCode === undefined || errorMessage === undefined)) {
    issues.push({
      path: "$.errorCode",
      message: "Rejected or failed receipts require errorCode and errorMessage",
    });
  }

  if (issues.length > 0) return invalid("Invalid session-action-receipt message", issues);

  return ok({
    type: "session-action-receipt",
    protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
    actionId: actionId as string,
    kind: kind as SessionActionReceipt["kind"],
    sessionId: sessionId as string,
    status: status as SessionActionReceipt["status"],
    ...(committedAt !== undefined ? { committedAt } : {}),
    ...(resultingSessionId !== undefined ? { resultingSessionId } : {}),
    ...(resultingEventId !== undefined ? { resultingEventId } : {}),
    ...(resultingWorkspaceVersionId !== undefined ? { resultingWorkspaceVersionId } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  });
}

export function validateSessionTreeEntry(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SESSION_TREE_ENTRY_FIELDS, issues, path);
  const type = requiredEnum(value, "type", `${path}.type`, ["node", "branch_summary"], issues);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  if ("parentId" in value) {
    readNullableString(value.parentId, `${path}.parentId`, issues);
  }
  requiredString(value, "createdAt", `${path}.createdAt`, issues, {
    nonEmpty: true,
  });

  if (type === "node") {
    if (!isJsonObject(value.payload)) {
      issues.push({ path: `${path}.payload`, message: "Expected JSON object" });
    }
    return;
  }

  requiredString(value, "summary", `${path}.summary`, issues);
  if ("abandonedLeafId" in value) {
    readNullableString(value.abandonedLeafId, `${path}.abandonedLeafId`, issues);
  }
  if (!isJsonObject(value.details)) {
    issues.push({ path: `${path}.details`, message: "Expected JSON object" });
  }
}

export function validateConversationRewindCheckpoint(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, REWIND_CHECKPOINT_FIELDS, issues, path);
  const source = requiredEnum(value, "source", `${path}.source`, ["runtime-manifest", "git-checkpoint"], issues);
  if (source === "runtime-manifest") {
    requiredString(value, "checkpointId", `${path}.checkpointId`, issues, {
      nonEmpty: true,
    });
    if ("manifestPath" in value) {
      optionalString(value, "manifestPath", `${path}.manifestPath`, issues, {
        nonEmpty: true,
      });
    }
    return;
  }

  if (source === "git-checkpoint") {
    requiredString(value, "checkpoint", `${path}.checkpoint`, issues, {
      nonEmpty: true,
    });
    if ("cleanUntracked" in value) {
      optionalBoolean(value, "cleanUntracked", `${path}.cleanUntracked`, issues);
    }
  }
}

export function validateConversationRewindActiveSubagent(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, REWIND_ACTIVE_SUBAGENT_FIELDS, issues, path);
  requiredString(value, "parentRunId", `${path}.parentRunId`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "subagentRunId", `${path}.subagentRunId`, issues, {
    nonEmpty: true,
  });
  if ("subagentId" in value) {
    optionalString(value, "subagentId", `${path}.subagentId`, issues, {
      nonEmpty: true,
    });
  }
}

export function validateConversationRewindBoundaryRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, REWIND_BOUNDARY_RECORD_FIELDS, issues, path);
  requiredString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  requiredString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString(value, "userMessageId", `${path}.userMessageId`, issues, { nonEmpty: true });
  optionalString(value, "sessionTreeLeafIdBefore", `${path}.sessionTreeLeafIdBefore`, issues, { nonEmpty: true });
  optionalString(value, "sessionTreeLeafIdAfter", `${path}.sessionTreeLeafIdAfter`, issues, { nonEmpty: true });
  optionalString(value, "runtimeLeafIdBefore", `${path}.runtimeLeafIdBefore`, issues, { nonEmpty: true });
  optionalString(value, "runtimeLeafIdAfter", `${path}.runtimeLeafIdAfter`, issues, { nonEmpty: true });
  requiredInteger(value, "eventSequence", `${path}.eventSequence`, issues, { min: 0 });
  requiredString(value, "workspaceRoot", `${path}.workspaceRoot`, issues, { nonEmpty: true });
  optionalString(value, "checkpointId", `${path}.checkpointId`, issues, { nonEmpty: true });
  optionalString(value, "checkpointRef", `${path}.checkpointRef`, issues, { nonEmpty: true });
  if ("checkpointSource" in value) {
    optionalEnum(value, "checkpointSource", `${path}.checkpointSource`, ["runtime", "tool", "external", "unknown"], issues);
  }
  requiredStringArray(value, "changedPaths", `${path}.changedPaths`, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  if ("metadata" in value && !isJsonObject(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected JSON object" });
  }
}

export function validateConversationRewindCheckpointRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, REWIND_CHECKPOINT_RECORD_FIELDS, issues, path);
  requiredString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  requiredString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString(value, "userMessageId", `${path}.userMessageId`, issues, { nonEmpty: true });
  if ("toolCall" in value) validateConversationRewindCheckpointToolCall(value.toolCall, `${path}.toolCall`, issues);
  requiredString(value, "checkpointId", `${path}.checkpointId`, issues, { nonEmpty: true });
  requiredString(value, "checkpointRef", `${path}.checkpointRef`, issues, { nonEmpty: true });
  requiredString(value, "workspaceRoot", `${path}.workspaceRoot`, issues, { nonEmpty: true });
  requiredStringArray(value, "changedPaths", `${path}.changedPaths`, issues);
  requiredEnum(value, "source", `${path}.source`, ["runtime", "tool", "external", "unknown"], issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  if ("metadata" in value && !isJsonObject(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected JSON object" });
  }
}

export function validateConversationRewindCheckpointToolCall(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields(value, REWIND_CHECKPOINT_TOOL_CALL_FIELDS, issues, path);
  optionalString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  optionalString(value, "toolName", `${path}.toolName`, issues, { nonEmpty: true });
  optionalString(value, "actor", `${path}.actor`, issues, { nonEmpty: true });
  optionalString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  optionalString(value, "targetSummary", `${path}.targetSummary`, issues, { nonEmpty: true });
}

export function validateConversationRewindTargetFacts(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, REWIND_TARGET_FACTS_FIELDS, issues, path);
  requiredString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  requiredString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString(value, "userMessageId", `${path}.userMessageId`, issues, { nonEmpty: true });
  requiredEnum(value, "mode", `${path}.mode`, ["keep-user-message", "remove-user-message"], issues);
  requiredInteger(value, "eventSequence", `${path}.eventSequence`, issues, { min: 0 });
  requiredString(value, "workspaceRoot", `${path}.workspaceRoot`, issues, { nonEmpty: true });
  requiredStringArray(value, "changedPaths", `${path}.changedPaths`, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  optionalString(value, "sessionTreeTargetLeafId", `${path}.sessionTreeTargetLeafId`, issues, { nonEmpty: true });
  optionalString(value, "runtimeTargetLeafId", `${path}.runtimeTargetLeafId`, issues, { nonEmpty: true });
  if ("checkpoint" in value) validateConversationRewindTargetCheckpointFacts(value.checkpoint, `${path}.checkpoint`, issues);
  const missingFacts = requiredArray(value, "missingFacts", `${path}.missingFacts`, issues);
  missingFacts?.forEach((fact, index) => validateConversationRewindMissingFact(fact, `${path}.missingFacts[${index}]`, issues));
  if ("metadata" in value && !isJsonObject(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected JSON object" });
  }
}

export function validateConversationRewindTargetCheckpointFacts(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields(value, REWIND_TARGET_CHECKPOINT_FACTS_FIELDS, issues, path);
  requiredString(value, "checkpointId", `${path}.checkpointId`, issues, { nonEmpty: true });
  requiredString(value, "checkpointRef", `${path}.checkpointRef`, issues, { nonEmpty: true });
  requiredEnum(value, "checkpointSource", `${path}.checkpointSource`, ["runtime", "tool", "external", "unknown"], issues);
  requiredString(value, "workspaceRoot", `${path}.workspaceRoot`, issues, { nonEmpty: true });
  requiredStringArray(value, "changedPaths", `${path}.changedPaths`, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
}

export function validateConversationRewindBoundaryDiagnostic(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }
  rejectUnknownFields(value, REWIND_BOUNDARY_DIAGNOSTIC_FIELDS, issues, path);
  requiredString(value, "code", `${path}.code`, issues, { nonEmpty: true });
  validateConversationRewindMissingFact(value.fact, `${path}.fact`, issues);
  requiredString(value, "message", `${path}.message`, issues);
  requiredBoolean(value, "blocked", `${path}.blocked`, issues);
  if ("metadata" in value && !isJsonObject(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected JSON object" });
  }
}

export function validateConversationRewindMissingFact(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (
    value !== "session-tree-target-leaf" &&
    value !== "runtime-target-leaf" &&
    value !== "workspace-checkpoint" &&
    value !== "boundary-record" &&
    value !== "checkpoint-manifest-record" &&
    value !== "session-record" &&
    value !== "session-tree-entries"
  ) {
    issues.push({ path, message: "Expected rewind missing fact" });
  }
}

export function validateConversationRewindPlan(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, REWIND_PLAN_FIELDS, issues, path);
  requiredString(value, "sessionId", `${path}.sessionId`, issues, {
    nonEmpty: true,
  });
  readNullableString(value.fromLeafId, `${path}.fromLeafId`, issues);
  readNullableString(value.targetLeafId, `${path}.targetLeafId`, issues);
  const targetPath = requiredArray(value, "targetPath", `${path}.targetPath`, issues);
  targetPath?.forEach((entry, index) =>
    validateSessionTreeEntry(entry, `${path}.targetPath[${index}]`, issues)
  );
  validateConversationRewindEntryProjection(value.entryProjection, `${path}.entryProjection`, issues);
  const runCancellations = requiredArray(value, "runCancellations", `${path}.runCancellations`, issues);
  runCancellations?.forEach((run, index) =>
    validateConversationRewindRunCancellation(run, `${path}.runCancellations[${index}]`, issues)
  );
  const approvalClearances = requiredArray(value, "approvalClearances", `${path}.approvalClearances`, issues);
  approvalClearances?.forEach((approval, index) =>
    validateConversationRewindApprovalClearance(approval, `${path}.approvalClearances[${index}]`, issues)
  );
  validateConversationRewindWorkspaceRestore(value.workspaceRestore, `${path}.workspaceRestore`, issues);
  const steps = requiredArray(value, "steps", `${path}.steps`, issues);
  steps?.forEach((step, index) => validateConversationRewindStep(step, `${path}.steps[${index}]`, issues));
}

export function validateConversationRewindEntryProjection(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, REWIND_ENTRY_PROJECTION_FIELDS, issues, path);
  const currentPath = requiredArray(value, "currentPath", `${path}.currentPath`, issues);
  currentPath?.forEach((entry, index) =>
    validateSessionTreeEntry(entry, `${path}.currentPath[${index}]`, issues)
  );
  const targetPath = requiredArray(value, "targetPath", `${path}.targetPath`, issues);
  targetPath?.forEach((entry, index) =>
    validateSessionTreeEntry(entry, `${path}.targetPath[${index}]`, issues)
  );
  if ("commonAncestorId" in value) {
    optionalString(value, "commonAncestorId", `${path}.commonAncestorId`, issues, {
      nonEmpty: true,
    });
  }
  requiredStringArray(value, "retainedEntryIds", `${path}.retainedEntryIds`, issues);
  requiredStringArray(value, "hiddenEntryIds", `${path}.hiddenEntryIds`, issues);
  requiredStringArray(
    value,
    "hiddenCurrentPathEntryIds",
    `${path}.hiddenCurrentPathEntryIds`,
    issues
  );
  requiredStringArray(value, "hiddenBranchEntryIds", `${path}.hiddenBranchEntryIds`, issues);
}

export function validateConversationRewindRunCancellation(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, REWIND_RUN_CANCELLATION_FIELDS, issues, path);
  requiredString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredEnum(value, "reason", `${path}.reason`, ["conversation-rewind"], issues);
  requiredEnum(value, "role", `${path}.role`, ["session-run", "subagent-run"], issues);
}

export function validateConversationRewindApprovalClearance(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, REWIND_APPROVAL_CLEARANCE_FIELDS, issues, path);
  requiredString(value, "toolCallId", `${path}.toolCallId`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredEnum(value, "reason", `${path}.reason`, ["conversation-rewind"], issues);
}

export function validateConversationRewindWorkspaceRestore(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, REWIND_WORKSPACE_RESTORE_FIELDS, issues, path);
  requiredBoolean(value, "required", `${path}.required`, issues);
  const source = requiredEnum(value, "source", `${path}.source`, ["runtime-manifest", "git-checkpoint", "none"], issues);
  if (source === "runtime-manifest") {
    requiredString(value, "checkpointId", `${path}.checkpointId`, issues, {
      nonEmpty: true,
    });
    if ("manifestPath" in value) {
      optionalString(value, "manifestPath", `${path}.manifestPath`, issues, {
        nonEmpty: true,
      });
    }
  }
  if (source === "git-checkpoint") {
    requiredString(value, "checkpoint", `${path}.checkpoint`, issues, {
      nonEmpty: true,
    });
  }
  requiredBoolean(value, "cleanUntracked", `${path}.cleanUntracked`, issues);
}

export function validateConversationRewindStep(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, REWIND_STEP_FIELDS, issues, path);
  const type = requiredEnum(
    value,
    "type",
    `${path}.type`,
    ["cancel-runs", "clear-approvals", "restore-workspace", "move-session-leaf"],
    issues
  );
  if (type === "cancel-runs") {
    const runs = requiredArray(value, "runs", `${path}.runs`, issues);
    runs?.forEach((run, index) =>
      validateConversationRewindRunCancellation(run, `${path}.runs[${index}]`, issues)
    );
  }
  if (type === "clear-approvals") {
    const approvals = requiredArray(value, "approvals", `${path}.approvals`, issues);
    approvals?.forEach((approval, index) =>
      validateConversationRewindApprovalClearance(approval, `${path}.approvals[${index}]`, issues)
    );
  }
  if (type === "restore-workspace") {
    validateConversationRewindWorkspaceRestore(value.restore, `${path}.restore`, issues);
  }
  if (type === "move-session-leaf") {
    requiredString(value, "sessionId", `${path}.sessionId`, issues, {
      nonEmpty: true,
    });
    readNullableString(value.fromLeafId, `${path}.fromLeafId`, issues);
    readNullableString(value.toLeafId, `${path}.toLeafId`, issues);
  }
}

export function validateConversationRewindStepResult(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, CONVERSATION_REWIND_STEP_RESULT_FIELDS, issues, path);
  requiredEnum(
    value,
    "type",
    `${path}.type`,
    ["cancel-runs", "clear-approvals", "restore-workspace", "move-session-leaf"],
    issues
  );
  requiredEnum(value, "status", `${path}.status`, ["applied", "deferred", "unsupported", "skipped", "failed"], issues);
  if ("code" in value) {
    optionalString(value, "code", `${path}.code`, issues, { nonEmpty: true });
  }
  if ("message" in value) {
    optionalString(value, "message", `${path}.message`, issues);
  }
  if ("affectedIds" in value) {
    const affectedIds = requiredArray(value, "affectedIds", `${path}.affectedIds`, issues);
    affectedIds?.forEach((id, index) => {
      if (typeof id !== "string" || id.length === 0) {
        issues.push({ path: `${path}.affectedIds[${index}]`, message: "Expected non-empty string" });
      }
    });
  }
  if ("metadata" in value && !isJsonObject(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected JSON object" });
  }
}

export function validateWorkflowDefinition(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, WORKFLOW_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "name", `${path}.name`, issues, { nonEmpty: true });
  requiredString(value, "prompt", `${path}.prompt`, issues, { nonEmpty: true });
  requiredString(value, "cwd", `${path}.cwd`, issues, { nonEmpty: true });
  requiredString(value, "mode", `${path}.mode`, issues, { nonEmpty: true });
  validateWorkflowSchedule(value.schedule, `${path}.schedule`, issues);
  requiredBoolean(value, "enabled", `${path}.enabled`, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
  if (!isJsonObject(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected JSON object" });
  }
}

export function validateWorkflowSchedule(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  readWorkflowSchedule(value, path, issues);
}

export function validateWorkflowRunEntry(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, WORKFLOW_RUN_FIELDS, issues, path);
  requiredString(value, "workflowId", `${path}.workflowId`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString(value, "sessionId", `${path}.sessionId`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "scheduledFor", `${path}.scheduledFor`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "startedAt", `${path}.startedAt`, issues, {
    nonEmpty: true,
  });
  requiredEnum(value, "status", `${path}.status`, WORKFLOW_RUN_STATUSES, issues);
  if ("error" in value) {
    optionalString(value, "error", `${path}.error`, issues);
  }
}

export function validatePlanDocumentPayload(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  const validation = validatePlanDocument(value as unknown as Parameters<typeof validatePlanDocument>[0]);
  for (const error of validation.errors) {
    issues.push({ path, message: error });
  }
}

export function validatePlanDocumentSummary(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, PLAN_DOCUMENT_SUMMARY_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "title", `${path}.title`, issues, { nonEmpty: true });
  requiredString(value, "goal", `${path}.goal`, issues, { nonEmpty: true });
  requiredString(value, "status", `${path}.status`, issues, { nonEmpty: true });
  requiredInteger(value, "version", `${path}.version`, issues, { min: 1 });
  requiredString(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  for (const field of ["steps", "questions", "assumptions", "acceptance", "risks"] as const) {
    if (!isRecord(value[field])) {
      issues.push({ path: `${path}.${field}`, message: "Expected object" });
    }
  }
}

export function validateMutationLeaseSnapshot(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, MUTATION_LEASE_FIELDS, issues, path);
  requiredString(value, "token", `${path}.token`, issues, { nonEmpty: true });
  validateMutationLeaseScope(value.scope, `${path}.scope`, issues);
  if ("owner" in value) {
    validateMutationLeaseOwner(value.owner, `${path}.owner`, issues);
  }
  requiredString(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  requiredString(value, "expiresAt", `${path}.expiresAt`, issues, { nonEmpty: true });
  requiredInteger(value, "ttlMs", `${path}.ttlMs`, issues, { min: 0 });
}

export function validateMutationLeaseScope(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  const type = requiredEnum(value, "type", `${path}.type`, ["workspace", "files"], issues);
  if (type === "workspace") {
    rejectUnknownFields(value, ["type"], issues, path);
    return;
  }

  rejectUnknownFields(value, ["type", "paths"], issues, path);
  const paths = requiredArray(value, "paths", `${path}.paths`, issues);
  paths?.forEach((item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      issues.push({ path: `${path}.paths[${index}]`, message: "Expected non-empty string" });
    }
  });
}

export function validateMutationLeaseOwner(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, MUTATION_LEASE_OWNER_FIELDS, issues, path);
  if ("runId" in value) optionalString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  if ("sessionId" in value) optionalString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  if ("toolCallId" in value) optionalString(value, "toolCallId", `${path}.toolCallId`, issues, { nonEmpty: true });
  if ("toolName" in value) optionalString(value, "toolName", `${path}.toolName`, issues, { nonEmpty: true });
  if ("cwd" in value) optionalString(value, "cwd", `${path}.cwd`, issues, { nonEmpty: true });
  if ("targetSummary" in value) optionalString(value, "targetSummary", `${path}.targetSummary`, issues);
}

export function validateArtifactRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, ARTIFACT_RECORD_FIELDS, issues, path);
  requiredString(value, "uri", `${path}.uri`, issues, { nonEmpty: true });
  requiredString(value, "type", `${path}.type`, issues, { nonEmpty: true });
  requiredString(value, "name", `${path}.name`, issues, { nonEmpty: true });
  if ("size" in value) optionalInteger(value, "size", `${path}.size`, issues, { min: 0 });
  if ("createdAt" in value) optionalString(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  if ("sessionId" in value) optionalString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  if ("runId" in value) optionalString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
}

export function validateMemoryRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, MEMORY_RECORD_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "key", `${path}.key`, issues, { nonEmpty: true });
  requiredString(value, "value", `${path}.value`, issues);
  requiredString(value, "scope", `${path}.scope`, issues, { nonEmpty: true });
  requiredString(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  if ("updatedAt" in value) optionalString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
}

export function validateCheckpointRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, CHECKPOINT_RECORD_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  if ("label" in value) optionalString(value, "label", `${path}.label`, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  if ("messageCount" in value) optionalInteger(value, "messageCount", `${path}.messageCount`, issues, { min: 0 });
}

export function validateChangedFileRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, CHANGED_FILE_RECORD_FIELDS, issues, path);
  requiredString(value, "path", `${path}.path`, issues, { nonEmpty: true });
  requiredString(value, "status", `${path}.status`, issues, { nonEmpty: true });
  if ("addedLines" in value) optionalInteger(value, "addedLines", `${path}.addedLines`, issues, { min: 0 });
  if ("removedLines" in value) optionalInteger(value, "removedLines", `${path}.removedLines`, issues, { min: 0 });
}

export function validateGitStatusFile(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, GIT_STATUS_FILE_FIELDS, issues, path);
  requiredString(value, "path", `${path}.path`, issues, { nonEmpty: true });
  requiredEnum(value, "status", `${path}.status`, ["A", "M", "D", "U", "R", "C", "?", "!", "mixed"] as const, issues);
  requiredString(value, "index", `${path}.index`, issues);
  requiredString(value, "worktree", `${path}.worktree`, issues);
  requiredBoolean(value, "staged", `${path}.staged`, issues);
  requiredBoolean(value, "unstaged", `${path}.unstaged`, issues);
  requiredBoolean(value, "untracked", `${path}.untracked`, issues);
  requiredBoolean(value, "conflicted", `${path}.conflicted`, issues);
  if ("originalPath" in value) optionalString(value, "originalPath", `${path}.originalPath`, issues, { nonEmpty: true });
}

export function validateMcpServerRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, MCP_SERVER_RECORD_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "name", `${path}.name`, issues, { nonEmpty: true });
  requiredString(value, "state", `${path}.state`, issues, { nonEmpty: true });
  if ("transport" in value) optionalString(value, "transport", `${path}.transport`, issues, { nonEmpty: true });
  if ("cachedToolCount" in value) optionalInteger(value, "cachedToolCount", `${path}.cachedToolCount`, issues, { min: 0 });
  if ("lastError" in value) optionalString(value, "lastError", `${path}.lastError`, issues);
  if ("startedAt" in value) optionalString(value, "startedAt", `${path}.startedAt`, issues, { nonEmpty: true });
}

export function validateScopedContextRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SCOPED_CONTEXT_RECORD_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "kind", `${path}.kind`, SCOPED_CONTEXT_KINDS, issues);
  requiredString(value, "title", `${path}.title`, issues, { nonEmpty: true });
  requiredString(value, "content", `${path}.content`, issues, { nonEmpty: true });
  if ("description" in value) optionalString(value, "description", `${path}.description`, issues, { nonEmpty: true });
  requiredEnum(value, "scope", `${path}.scope`, SCOPED_CONTEXT_SCOPES, issues);
  requiredEnum(value, "activation", `${path}.activation`, SCOPED_CONTEXT_ACTIVATIONS, issues);
  requiredStringArray(value, "appliesTo", `${path}.appliesTo`, issues);
  requiredStringArray(value, "tags", `${path}.tags`, issues);
  if ("source" in value) validateScopedContextSource(value.source, `${path}.source`, issues);
  if ("sourceMetadata" in value && !isJsonObject(value.sourceMetadata)) {
    issues.push({ path: `${path}.sourceMetadata`, message: "Expected JSON object" });
  }
  if ("order" in value) {
    optionalNumber(value, "order", `${path}.order`, issues);
  } else {
    issues.push({ path: `${path}.order`, message: "Required field is missing" });
  }
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
}

export function validateScopedContextSource(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SCOPED_CONTEXT_SOURCE_FIELDS, issues, path);
  requiredEnum(value, "type", `${path}.type`, SCOPED_CONTEXT_SOURCE_TYPES, issues);
  if ("path" in value) optionalString(value, "path", `${path}.path`, issues, { nonEmpty: true });
  if ("label" in value) optionalString(value, "label", `${path}.label`, issues, { nonEmpty: true });
}

export function validateScopedContextStoreDiagnostic(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SCOPED_CONTEXT_DIAGNOSTIC_FIELDS, issues, path);
  requiredString(value, "code", `${path}.code`, issues, { nonEmpty: true });
  requiredString(value, "message", `${path}.message`, issues, { nonEmpty: true });
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  if ("path" in value) optionalString(value, "path", `${path}.path`, issues, { nonEmpty: true });
  if ("detail" in value) optionalString(value, "detail", `${path}.detail`, issues);
}

export function validateScopedContextCandidate(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SCOPED_CONTEXT_CANDIDATE_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "kind", `${path}.kind`, SCOPED_CONTEXT_KINDS, issues);
  requiredString(value, "title", `${path}.title`, issues, { nonEmpty: true });
  if ("description" in value) optionalString(value, "description", `${path}.description`, issues, { nonEmpty: true });
  requiredEnum(value, "scope", `${path}.scope`, SCOPED_CONTEXT_SCOPES, issues);
  requiredEnum(value, "activation", `${path}.activation`, SCOPED_CONTEXT_ACTIVATIONS, issues);
  requiredStringArray(value, "appliesTo", `${path}.appliesTo`, issues);
  requiredStringArray(value, "tags", `${path}.tags`, issues);
  if ("source" in value) validateScopedContextSource(value.source, `${path}.source`, issues);
  requiredString(value, "reason", `${path}.reason`, issues, { nonEmpty: true });
}

export function validateScopedContextResolvedItem(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SCOPED_CONTEXT_ITEM_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "kind", `${path}.kind`, SCOPED_CONTEXT_KINDS, issues);
  requiredString(value, "title", `${path}.title`, issues, { nonEmpty: true });
  if ("description" in value) optionalString(value, "description", `${path}.description`, issues, { nonEmpty: true });
  requiredEnum(value, "scope", `${path}.scope`, SCOPED_CONTEXT_SCOPES, issues);
  requiredEnum(value, "activation", `${path}.activation`, SCOPED_CONTEXT_ACTIVATIONS, issues);
  requiredStringArray(value, "appliesTo", `${path}.appliesTo`, issues);
  requiredStringArray(value, "tags", `${path}.tags`, issues);
  if ("source" in value) validateScopedContextSource(value.source, `${path}.source`, issues);
  requiredString(value, "reason", `${path}.reason`, issues, { nonEmpty: true });
  requiredEnum(value, "status", `${path}.status`, SCOPED_CONTEXT_ITEM_STATUSES, issues);
}

export function validateScopedContextResolverDiagnostic(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_FIELDS, issues, path);
  requiredEnum(value, "severity", `${path}.severity`, SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_SEVERITIES, issues);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "code", `${path}.code`, SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_CODES, issues);
  requiredString(value, "message", `${path}.message`, issues, { nonEmpty: true });
}

export function validateScopedContextResourceDiagnostic(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SCOPED_CONTEXT_RESOURCE_DIAGNOSTIC_FIELDS, issues, path);
  requiredEnum(value, "severity", `${path}.severity`, ["warning"], issues);
  requiredString(value, "path", `${path}.path`, issues, { nonEmpty: true });
  requiredString(value, "message", `${path}.message`, issues, { nonEmpty: true });
}

export function validatePromptContextBlock(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, PROMPT_CONTEXT_BLOCK_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "kind", `${path}.kind`, PROMPT_CONTEXT_BLOCK_KINDS, issues);
  if ("label" in value) optionalString(value, "label", `${path}.label`, issues, { nonEmpty: true });
  if (!("content" in value)) {
    issues.push({ path: `${path}.content`, message: "Required field is missing" });
  } else if (!isJsonValue(value.content)) {
    issues.push({ path: `${path}.content`, message: "Expected JSON value" });
  }
}

export function validateLifecycleSnapshot(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  rejectUnknownFields(value, LIFECYCLE_FIELDS, issues, path);
  requiredEnum(value, "state", `${path}.state`, DAEMON_LIFECYCLE_STATES, issues);
  requiredString(value, "startedAt", `${path}.startedAt`, issues, { nonEmpty: true });
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  if ("readyAt" in value) optionalString(value, "readyAt", `${path}.readyAt`, issues, { nonEmpty: true });
  if ("stoppingAt" in value) optionalString(value, "stoppingAt", `${path}.stoppingAt`, issues, { nonEmpty: true });
  if ("stoppedAt" in value) optionalString(value, "stoppedAt", `${path}.stoppedAt`, issues, { nonEmpty: true });
  requiredInteger(value, "uptimeMs", `${path}.uptimeMs`, issues, { min: 0 });
  requiredNullableInteger(value, "currentPort", `${path}.currentPort`, issues, { min: 0 });
  requiredInteger(value, "connectedClientCount", `${path}.connectedClientCount`, issues, { min: 0 });
  requiredInteger(value, "totalClientConnectionCount", `${path}.totalClientConnectionCount`, issues, { min: 0 });
  requiredInteger(value, "totalClientDisconnectCount", `${path}.totalClientDisconnectCount`, issues, { min: 0 });
  requiredInteger(value, "activeRunCount", `${path}.activeRunCount`, issues, { min: 0 });

  if ("recentDisconnect" in value) {
    validateClientDisconnect(value.recentDisconnect, `${path}.recentDisconnect`, issues);
  }
  if ("recentError" in value) {
    validateLifecycleDiagnostic(value.recentError, `${path}.recentError`, issues);
  }
  const eventStore = requiredRecord(value, "eventStore", `${path}.eventStore`, issues);
  if (eventStore) validateEventStoreStatus(eventStore, `${path}.eventStore`, issues);
  requiredEnum(value, "providerReadiness", `${path}.providerReadiness`, PROVIDER_READINESS_STATUSES, issues);
  requiredEnum(value, "mcpReadiness", `${path}.mcpReadiness`, MCP_READINESS_STATUSES, issues);
}

export function validateClientDisconnect(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, CLIENT_DISCONNECT_FIELDS, issues, path);
  requiredString(value, "clientId", `${path}.clientId`, issues, { nonEmpty: true });
  requiredInteger(value, "code", `${path}.code`, issues, { min: 0 });
  requiredString(value, "reason", `${path}.reason`, issues);
  requiredString(value, "connectedAt", `${path}.connectedAt`, issues, { nonEmpty: true });
  requiredString(value, "disconnectedAt", `${path}.disconnectedAt`, issues, { nonEmpty: true });
  requiredInteger(value, "durationMs", `${path}.durationMs`, issues, { min: 0 });
}

export function validateEventStoreStatus(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  rejectUnknownFields(value, EVENT_STORE_STATUS_FIELDS, issues, path);
  requiredEnum(value, "status", `${path}.status`, EVENT_STORE_STATUSES, issues);
  requiredString(value, "path", `${path}.path`, issues, { nonEmpty: true });
  if ("failure" in value) {
    validateLifecycleDiagnostic(value.failure, `${path}.failure`, issues);
  }
}

export function validateLifecycleDiagnostic(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, LIFECYCLE_DIAGNOSTIC_FIELDS, issues, path);
  requiredString(value, "code", `${path}.code`, issues, { nonEmpty: true });
  requiredString(value, "message", `${path}.message`, issues);
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  requiredEnum(value, "source", `${path}.source`, LIFECYCLE_DIAGNOSTIC_SOURCES, issues);
  requiredEnum(value, "severity", `${path}.severity`, LIFECYCLE_DIAGNOSTIC_SEVERITIES, issues);
  if ("detail" in value) optionalString(value, "detail", `${path}.detail`, issues);
  if ("metadata" in value && !isRecord(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}

export function validateStatusActiveRun(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, ACTIVE_RUN_FIELDS, issues, path);
  requiredString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString(value, "prompt", `${path}.prompt`, issues);
  requiredString(value, "status", `${path}.status`, issues, { nonEmpty: true });
  requiredInteger(value, "startedAt", `${path}.startedAt`, issues, { min: 0 });
  requiredString(value, "cwd", `${path}.cwd`, issues);
}

export function validatePendingApproval(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, PENDING_APPROVAL_FIELDS, issues, path);
  requiredString(value, "toolCallId", `${path}.toolCallId`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString(value, "toolName", `${path}.toolName`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "summary", `${path}.summary`, issues);
  requiredInteger(value, "createdAt", `${path}.createdAt`, issues, { min: 0 });
  requiredEnum(value, "status", `${path}.status`, ["pending", "approved", "denied", "expired"], issues);
  requiredNullableInteger(value, "timeoutMs", `${path}.timeoutMs`, issues, { min: 0 });
  requiredNullableInteger(value, "expiresAt", `${path}.expiresAt`, issues, { min: 0 });
  requiredNullableInteger(value, "remainingMs", `${path}.remainingMs`, issues, { min: 0 });
  if ("resolvedAt" in value) optionalInteger(value, "resolvedAt", `${path}.resolvedAt`, issues, { min: 0 });
  if ("expiredAt" in value) optionalInteger(value, "expiredAt", `${path}.expiredAt`, issues, { min: 0 });
  if ("reason" in value) optionalString(value, "reason", `${path}.reason`, issues);
  if ("expiredReason" in value) optionalString(value, "expiredReason", `${path}.expiredReason`, issues);
  if ("risk" in value) optionalString(value, "risk", `${path}.risk`, issues);
  if ("riskReason" in value) optionalString(value, "riskReason", `${path}.riskReason`, issues);
  if ("requiresDoubleConfirm" in value) {
    optionalBoolean(value, "requiresDoubleConfirm", `${path}.requiresDoubleConfirm`, issues);
  }
  if ("recommendSnapshot" in value) {
    optionalBoolean(value, "recommendSnapshot", `${path}.recommendSnapshot`, issues);
  }
  if ("metadata" in value && !isRecord(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}

export function validateProviderStatus(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, PROVIDER_STATUS_FIELDS, issues, path);
  requiredEnum(value, "credentialMode", `${path}.credentialMode`, PROVIDER_CREDENTIAL_MODES, issues);
  requiredEnum(value, "readiness", `${path}.readiness`, PROVIDER_READINESS_STATUSES, issues);
  requiredString(value, "providerId", `${path}.providerId`, issues, { nonEmpty: true });
  requiredString(value, "routeId", `${path}.routeId`, issues, { nonEmpty: true });
  requiredString(value, "baseUrl", `${path}.baseUrl`, issues);
  requiredString(value, "model", `${path}.model`, issues);
  requiredString(value, "upstreamModel", `${path}.upstreamModel`, issues);
  requiredEnum(value, "endpoint", `${path}.endpoint`, PROVIDER_ENDPOINTS, issues);
  requiredBoolean(value, "stream", `${path}.stream`, issues);
  requiredEnum(value, "systemPromptWireMode", `${path}.systemPromptWireMode`, SYSTEM_PROMPT_WIRE_MODES, issues);
  const apiKey = requiredRecord(value, "apiKey", `${path}.apiKey`, issues);
  if (apiKey) validateRedactedApiKeyStatus(apiKey, `${path}.apiKey`, issues);
  requiredBoolean(value, "hasDirectApiKey", `${path}.hasDirectApiKey`, issues);
  requiredEnum(value, "apiKeySource", `${path}.apiKeySource`, PROVIDER_API_KEY_SOURCES, issues);

  const gateway = requiredRecord(value, "gateway", `${path}.gateway`, issues);
  if (gateway) validateProviderGatewayStatus(gateway, `${path}.gateway`, issues);
  if ("lastDiagnostic" in value) {
    validateProviderDiagnostic(value.lastDiagnostic, `${path}.lastDiagnostic`, issues);
  }
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
}

export function validateRedactedApiKeyStatus(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  rejectUnknownFields(value, PROVIDER_REDACTED_API_KEY_FIELDS, issues, path);
  requiredBoolean(value, "hasApiKey", `${path}.hasApiKey`, issues);
  requiredEnum(value, "source", `${path}.source`, PROVIDER_API_KEY_SOURCES, issues);
  if ("last4" in value) optionalString(value, "last4", `${path}.last4`, issues, { nonEmpty: true });
}

export function validateProviderGatewayStatus(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  rejectUnknownFields(value, PROVIDER_GATEWAY_STATUS_FIELDS, issues, path);
  requiredBoolean(value, "ready", `${path}.ready`, issues);
  requiredBoolean(value, "credentialConfigured", `${path}.credentialConfigured`, issues);
  const routeDecision = requiredArray(value, "routeDecision", `${path}.routeDecision`, issues);
  routeDecision?.forEach((item, index) => {
    if (typeof item !== "string") {
      issues.push({ path: `${path}.routeDecision[${index}]`, message: "Expected string" });
    }
  });
  if ("code" in value) optionalString(value, "code", `${path}.code`, issues, { nonEmpty: true });
  if ("selectedRouteId" in value) optionalString(value, "selectedRouteId", `${path}.selectedRouteId`, issues, { nonEmpty: true });
  if ("selectedProviderId" in value) optionalString(value, "selectedProviderId", `${path}.selectedProviderId`, issues, { nonEmpty: true });
  if ("selectedEndpointSupport" in value) optionalEnum(value, "selectedEndpointSupport", `${path}.selectedEndpointSupport`, PROVIDER_ENDPOINTS, issues);
  if ("selectedStreamingSupport" in value) optionalString(value, "selectedStreamingSupport", `${path}.selectedStreamingSupport`, issues, { nonEmpty: true });
  if ("selectedCredentialSource" in value && !isRecord(value.selectedCredentialSource)) {
    issues.push({ path: `${path}.selectedCredentialSource`, message: "Expected object" });
  }
  if ("lastSuccess" in value && !isRecord(value.lastSuccess)) {
    issues.push({ path: `${path}.lastSuccess`, message: "Expected object" });
  }
  if ("lastFailure" in value && !isRecord(value.lastFailure)) {
    issues.push({ path: `${path}.lastFailure`, message: "Expected object" });
  }
  if ("updatedAt" in value) optionalString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
}

export function validateProviderDiagnostic(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, PROVIDER_DIAGNOSTIC_FIELDS, issues, path);
  requiredString(value, "code", `${path}.code`, issues, { nonEmpty: true });
  requiredString(value, "message", `${path}.message`, issues);
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  if ("kind" in value) optionalString(value, "kind", `${path}.kind`, issues, { nonEmpty: true });
  if ("status" in value) optionalInteger(value, "status", `${path}.status`, issues, { min: 100 });
  if ("detail" in value) optionalString(value, "detail", `${path}.detail`, issues);
  if ("metadata" in value && !isRecord(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}

export function validateMcpStatus(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  rejectUnknownFields(value, MCP_STATUS_FIELDS, issues, path);
  requiredBoolean(value, "configured", `${path}.configured`, issues);
  requiredEnum(value, "readiness", `${path}.readiness`, MCP_READINESS_STATUSES, issues);
  requiredInteger(value, "serverCount", `${path}.serverCount`, issues, { min: 0 });
  requiredRecord(value, "summary", `${path}.summary`, issues);
  const diagnostics = requiredArray(value, "diagnostics", `${path}.diagnostics`, issues);
  diagnostics?.forEach((diagnostic, index) => {
    if (!isRecord(diagnostic)) {
      issues.push({ path: `${path}.diagnostics[${index}]`, message: "Expected object" });
    }
  });
  const servers = requiredArray(value, "servers", `${path}.servers`, issues);
  servers?.forEach((server, index) => {
    if (!isRecord(server)) {
      issues.push({ path: `${path}.servers[${index}]`, message: "Expected object" });
    }
  });
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
}

export function validateCapabilitySnapshot(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  rejectUnknownFields(value, CAPABILITY_SNAPSHOT_FIELDS, issues, path);
  const schemaVersion = requiredInteger(value, "schemaVersion", `${path}.schemaVersion`, issues, {
    min: 1,
  });
  if (schemaVersion !== undefined && schemaVersion !== 1) {
    issues.push({ path: `${path}.schemaVersion`, message: "Expected capability schema version 1" });
  }
  requiredString(value, "generatedAt", `${path}.generatedAt`, issues, { nonEmpty: true });
  const capabilities = requiredArray(value, "capabilities", `${path}.capabilities`, issues);
  capabilities?.forEach((capability, index) =>
    validateCapabilityRecord(capability, `${path}.capabilities[${index}]`, issues)
  );
}

export function validateCapabilityRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, CAPABILITY_RECORD_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "title", `${path}.title`, issues, { nonEmpty: true });
  requiredEnum(value, "state", `${path}.state`, CAPABILITY_STATES, issues);
  requiredString(value, "reason", `${path}.reason`, issues, { nonEmpty: true });
  requiredEnum(value, "owner", `${path}.owner`, CAPABILITY_OWNERS, issues);
  requiredStringArray(value, "relatedMessageTypes", `${path}.relatedMessageTypes`, issues);
  requiredStringArray(value, "relatedTauriCommands", `${path}.relatedTauriCommands`, issues);
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  const diagnostics = requiredArray(value, "diagnostics", `${path}.diagnostics`, issues);
  diagnostics?.forEach((diagnostic, index) =>
    validateCapabilityDiagnostic(diagnostic, `${path}.diagnostics[${index}]`, issues)
  );
}

export function validateCapabilityDiagnostic(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, CAPABILITY_DIAGNOSTIC_FIELDS, issues, path);
  requiredString(value, "code", `${path}.code`, issues, { nonEmpty: true });
  requiredString(value, "message", `${path}.message`, issues, { nonEmpty: true });
  requiredEnum(value, "severity", `${path}.severity`, CAPABILITY_DIAGNOSTIC_SEVERITIES, issues);
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  if ("detail" in value) optionalString(value, "detail", `${path}.detail`, issues);
  if ("metadata" in value && !isRecord(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}

export function validateTaskSnapshot(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_SNAPSHOT_FIELDS, issues, path);
  requiredString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString(value, "sessionId", `${path}.sessionId`, issues, {
    nonEmpty: true,
  });
  requiredEnum(value, "status", `${path}.status`, RUN_STATUSES, issues);
  requiredString(value, "title", `${path}.title`, issues);
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "progressLabel", `${path}.progressLabel`, issues);

  const messages = requiredArray(value, "messages", `${path}.messages`, issues);
  messages?.forEach((message, index) =>
    validateTaskMessage(message, `${path}.messages[${index}]`, issues)
  );

  if ("latestError" in value) {
    optionalString(value, "latestError", `${path}.latestError`, issues);
  }
  if ("approval" in value) {
    validateTaskApproval(value.approval, `${path}.approval`, issues);
  }

  const pendingToolCalls = requiredArray(
    value,
    "pendingToolCalls",
    `${path}.pendingToolCalls`,
    issues
  );
  pendingToolCalls?.forEach((toolCall, index) =>
    validateTaskToolCall(toolCall, `${path}.pendingToolCalls[${index}]`, issues)
  );

  const backgroundTasks = requiredArray(
    value,
    "backgroundTasks",
    `${path}.backgroundTasks`,
    issues
  );
  backgroundTasks?.forEach((task, index) =>
    validateTaskBackgroundTask(task, `${path}.backgroundTasks[${index}]`, issues)
  );

  validateTaskProgress(value.progress, `${path}.progress`, issues);
  validateTaskUsage(value.usage, `${path}.usage`, issues);
  validateTaskCache(value.cache, `${path}.cache`, issues);
  validateTaskCurrentRun(value.currentRun, `${path}.currentRun`, issues);
}

export function validateTaskMessage(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_MESSAGE_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "role", `${path}.role`, ["system", "user", "assistant"], issues);
  requiredString(value, "content", `${path}.content`, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, {
    nonEmpty: true,
  });
  if ("toolCalls" in value) {
    const toolCalls = requiredArray(value, "toolCalls", `${path}.toolCalls`, issues);
    toolCalls?.forEach((toolCall, index) =>
      validateTaskToolCall(toolCall, `${path}.toolCalls[${index}]`, issues)
    );
  }
}

export function validateTaskToolCall(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_TOOL_CALL_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "name", `${path}.name`, issues, { nonEmpty: true });
  requiredRecord(value, "input", `${path}.input`, issues);
  requiredEnum(
    value,
    "status",
    `${path}.status`,
    ["pending", "running", "approval-required", "completed", "failed"],
    issues
  );
  if ("summary" in value) optionalString(value, "summary", `${path}.summary`, issues);
  requiredString(value, "startedAt", `${path}.startedAt`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
  if ("output" in value) optionalString(value, "output", `${path}.output`, issues);
  if ("approvalMetadata" in value && !isRecord(value.approvalMetadata)) {
    issues.push({ path: `${path}.approvalMetadata`, message: "Expected object" });
  }
}

export function validateTaskApproval(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_APPROVAL_FIELDS, issues, path);
  requiredString(value, "toolCallId", `${path}.toolCallId`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "toolName", `${path}.toolName`, issues, {
    nonEmpty: true,
  });
  requiredRecord(value, "input", `${path}.input`, issues);
  requiredString(value, "summary", `${path}.summary`, issues);
  requiredString(value, "requestedAt", `${path}.requestedAt`, issues, {
    nonEmpty: true,
  });
  requiredEnum(value, "status", `${path}.status`, ["pending"], issues);
  if ("risk" in value) optionalString(value, "risk", `${path}.risk`, issues);
  if ("riskReason" in value) optionalString(value, "riskReason", `${path}.riskReason`, issues);
  if ("requiresDoubleConfirm" in value) {
    optionalBoolean(value, "requiresDoubleConfirm", `${path}.requiresDoubleConfirm`, issues);
  }
  if ("recommendSnapshot" in value) {
    optionalBoolean(value, "recommendSnapshot", `${path}.recommendSnapshot`, issues);
  }
  if ("metadata" in value && !isRecord(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}

export function validateTaskProgress(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_PROGRESS_FIELDS, issues, path);
  requiredString(value, "label", `${path}.label`, issues);
  requiredInteger(value, "eventCount", `${path}.eventCount`, issues, { min: 0 });
  requiredInteger(value, "turnCount", `${path}.turnCount`, issues, { min: 0 });
  requiredInteger(value, "textDeltaCount", `${path}.textDeltaCount`, issues, { min: 0 });
  requiredInteger(value, "toolCallCount", `${path}.toolCallCount`, issues, { min: 0 });
  requiredInteger(value, "completedToolCallCount", `${path}.completedToolCallCount`, issues, { min: 0 });
  requiredInteger(value, "pendingToolCallCount", `${path}.pendingToolCallCount`, issues, { min: 0 });
  requiredBoolean(value, "approvalPending", `${path}.approvalPending`, issues);
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
}

export function validateTaskUsage(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_USAGE_FIELDS, issues, path);
  requiredInteger(value, "sampleCount", `${path}.sampleCount`, issues, { min: 0 });
  requiredInteger(value, "promptTokens", `${path}.promptTokens`, issues, { min: 0 });
  requiredInteger(value, "completionTokens", `${path}.completionTokens`, issues, { min: 0 });
  requiredInteger(value, "totalTokens", `${path}.totalTokens`, issues, { min: 0 });
  requiredInteger(value, "reasoningTokens", `${path}.reasoningTokens`, issues, { min: 0 });
}

export function validateTaskCache(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_CACHE_FIELDS, issues, path);
  requiredInteger(value, "sampleCount", `${path}.sampleCount`, issues, { min: 0 });
  requiredInteger(value, "promptTokens", `${path}.promptTokens`, issues, { min: 0 });
  requiredInteger(value, "readTokens", `${path}.readTokens`, issues, { min: 0 });
  requiredInteger(value, "writeTokens", `${path}.writeTokens`, issues, { min: 0 });
  requiredInteger(value, "missTokens", `${path}.missTokens`, issues, { min: 0 });
  requiredNumber(value, "hitRatio", `${path}.hitRatio`, issues, { min: 0, max: 1 });
  requiredNumber(value, "writeRatio", `${path}.writeRatio`, issues, { min: 0 });
  if ("stablePrefixHash" in value) optionalString(value, "stablePrefixHash", `${path}.stablePrefixHash`, issues);
  if ("cacheKey" in value) optionalString(value, "cacheKey", `${path}.cacheKey`, issues);
  if ("cacheStrategy" in value) optionalString(value, "cacheStrategy", `${path}.cacheStrategy`, issues);
}

export function validateTaskBackgroundTask(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_BACKGROUND_TASK_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "kind", `${path}.kind`, ["command"], issues);
  requiredString(value, "title", `${path}.title`, issues);
  requiredEnum(
    value,
    "state",
    `${path}.state`,
    ["running", "succeeded", "failed", "cancelled", "timed-out"],
    issues
  );
  requiredString(value, "command", `${path}.command`, issues);
  if ("cwd" in value) optionalString(value, "cwd", `${path}.cwd`, issues);
  if ("startedAt" in value) optionalString(value, "startedAt", `${path}.startedAt`, issues);
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
  if ("finishedAt" in value) optionalString(value, "finishedAt", `${path}.finishedAt`, issues);
  if ("durationMs" in value) optionalNumber(value, "durationMs", `${path}.durationMs`, issues, { min: 0 });
  if ("exitCode" in value) optionalNullableNumber(value, "exitCode", `${path}.exitCode`, issues);
  if ("signal" in value) optionalNullableString(value, "signal", `${path}.signal`, issues);
  if ("outputPreview" in value) optionalString(value, "outputPreview", `${path}.outputPreview`, issues);
}

export function validateTaskCurrentRun(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, TASK_CURRENT_RUN_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "sessionId", `${path}.sessionId`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "cwd", `${path}.cwd`, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
  if ("startedAt" in value) optionalString(value, "startedAt", `${path}.startedAt`, issues);
  if ("finishedAt" in value) optionalString(value, "finishedAt", `${path}.finishedAt`, issues);
  requiredRecord(value, "metadata", `${path}.metadata`, issues);
}

export function validateSessionRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SESSION_RECORD_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "cwd", `${path}.cwd`, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
  requiredEnum(value, "status", `${path}.status`, SESSION_STATUSES, issues);
  if ("currentLeafId" in value) {
    optionalString(value, "currentLeafId", `${path}.currentLeafId`, issues, {
      nonEmpty: true,
    });
  }
  if ("metadata" in value && !isRecord(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}

export function validateSessionSummary(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(
    value,
    [
      "sessionId",
      "lastUpdated",
      "eventCount",
      "runCount",
      "activeRunCount",
      "activeRunIds",
      "latestRunId",
      "latestRunStatus",
      "latestRunUpdatedAt",
      "pendingInputCount",
      "pendingApprovalCount",
      "lastEventId",
      "lastSequence",
      "lastMessagePreview",
      "title",
      "pinned",
      "archived",
      "deleted",
      "metadataUpdatedAt",
    ],
    issues,
    path
  );
  requiredString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  requiredString(value, "lastUpdated", `${path}.lastUpdated`, issues, { nonEmpty: true });
  requiredInteger(value, "eventCount", `${path}.eventCount`, issues, { min: 0 });
  requiredInteger(value, "runCount", `${path}.runCount`, issues, { min: 0 });
  if ("activeRunCount" in value) {
    optionalInteger(value, "activeRunCount", `${path}.activeRunCount`, issues, { min: 0 });
  }
  if ("activeRunIds" in value) {
    optionalStringArray(value, "activeRunIds", `${path}.activeRunIds`, issues);
  }
  if ("latestRunId" in value) {
    optionalString(value, "latestRunId", `${path}.latestRunId`, issues, { nonEmpty: true });
  }
  if ("latestRunStatus" in value) {
    optionalEnum(value, "latestRunStatus", `${path}.latestRunStatus`, RUN_STATUSES, issues);
  }
  if ("latestRunUpdatedAt" in value) {
    optionalString(value, "latestRunUpdatedAt", `${path}.latestRunUpdatedAt`, issues, { nonEmpty: true });
  }
  if ("pendingApprovalCount" in value) {
    optionalInteger(value, "pendingApprovalCount", `${path}.pendingApprovalCount`, issues, { min: 0 });
  }
  if ("pendingInputCount" in value) {
    optionalInteger(value, "pendingInputCount", `${path}.pendingInputCount`, issues, { min: 0 });
  }
  if ("lastEventId" in value) {
    optionalString(value, "lastEventId", `${path}.lastEventId`, issues, { nonEmpty: true });
  }
  if ("lastSequence" in value) {
    optionalInteger(value, "lastSequence", `${path}.lastSequence`, issues, { min: 1 });
  }
  if ("lastMessagePreview" in value) {
    optionalString(value, "lastMessagePreview", `${path}.lastMessagePreview`, issues, { nonEmpty: true });
  }
  if ("title" in value) {
    optionalString(value, "title", `${path}.title`, issues);
  }
  if ("pinned" in value) {
    optionalBoolean(value, "pinned", `${path}.pinned`, issues);
  }
  if ("archived" in value) {
    optionalBoolean(value, "archived", `${path}.archived`, issues);
  }
  if ("deleted" in value) {
    optionalBoolean(value, "deleted", `${path}.deleted`, issues);
  }
  if ("metadataUpdatedAt" in value) {
    optionalString(value, "metadataUpdatedAt", `${path}.metadataUpdatedAt`, issues, { nonEmpty: true });
  }
}

export function validatePendingInputRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, PENDING_INPUT_RECORD_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  requiredString(value, "text", `${path}.text`, issues, { nonEmpty: true });
  requiredEnum(value, "mode", `${path}.mode`, PENDING_INPUT_MODES, issues);
  requiredEnum(value, "status", `${path}.status`, PENDING_INPUT_STATUSES, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  if ("runId" in value) {
    optionalString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  }
  if ("source" in value) {
    optionalEnum(value, "source", `${path}.source`, PENDING_INPUT_SOURCES, issues);
  }
  if ("metadata" in value && !isRecord(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}

export function validateRunRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, RUN_RECORD_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "sessionId", `${path}.sessionId`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "cwd", `${path}.cwd`, issues);
  requiredEnum(value, "status", `${path}.status`, RUN_STATUSES, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, {
    nonEmpty: true,
  });
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, {
    nonEmpty: true,
  });
  if ("startedAt" in value) {
    optionalString(value, "startedAt", `${path}.startedAt`, issues, {
      nonEmpty: true,
    });
  }
  if ("finishedAt" in value) {
    optionalString(value, "finishedAt", `${path}.finishedAt`, issues, {
      nonEmpty: true,
    });
  }
  if ("outcome" in value) {
    optionalString(value, "outcome", `${path}.outcome`, issues, {
      nonEmpty: true,
    });
  }
  if ("reason" in value) {
    optionalString(value, "reason", `${path}.reason`, issues, {
      nonEmpty: true,
    });
  }
  if ("outcomeDetail" in value && !isRecord(value.outcomeDetail)) {
    issues.push({ path: `${path}.outcomeDetail`, message: "Expected object" });
  }
  if ("error" in value) {
    optionalString(value, "error", `${path}.error`, issues);
  }
  if ("kind" in value) {
    optionalEnum(value, "kind", `${path}.kind`, RUN_KINDS, issues);
  }
  if ("goal" in value) {
    validateGoalRunState(value.goal, `${path}.goal`, issues);
  }
  if ("lastEventId" in value) {
    optionalString(value, "lastEventId", `${path}.lastEventId`, issues, {
      nonEmpty: true,
    });
  }
  if ("metadata" in value && !isRecord(value.metadata)) {
    issues.push({ path: `${path}.metadata`, message: "Expected object" });
  }
}

export function validateGoalRunState(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, GOAL_STATE_FIELDS, issues, path);
  requiredEnum(value, "status", `${path}.status`, GOAL_RUN_STATUSES, issues);
  if ("visibleGoal" in value) {
    optionalString(value, "visibleGoal", `${path}.visibleGoal`, issues);
  }
  requiredInteger(value, "maxRounds", `${path}.maxRounds`, issues, { min: 1 });
  requiredInteger(value, "maxStalledRounds", `${path}.maxStalledRounds`, issues, { min: 1 });
  requiredInteger(value, "currentRound", `${path}.currentRound`, issues, { min: 0 });
  requiredInteger(value, "completedRounds", `${path}.completedRounds`, issues, { min: 0 });
  requiredInteger(value, "stalledRounds", `${path}.stalledRounds`, issues, { min: 0 });
  if ("stoppedReason" in value) {
    optionalEnum(value, "stoppedReason", `${path}.stoppedReason`, GOAL_STOPPED_REASONS, issues);
  }
  if ("lastProgressSignature" in value) {
    optionalString(value, "lastProgressSignature", `${path}.lastProgressSignature`, issues);
  }
  if ("lastDecision" in value) {
    validateGoalContinuationDecision(value.lastDecision, `${path}.lastDecision`, issues);
  }
}

export function validateGoalContinuationDecision(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, GOAL_DECISION_FIELDS, issues, path);
  requiredEnum(value, "action", `${path}.action`, GOAL_CONTINUATION_ACTIONS, issues);
  requiredString(value, "reason", `${path}.reason`, issues);
  if ("prompt" in value) {
    optionalString(value, "prompt", `${path}.prompt`, issues);
  }
  if ("progressSignature" in value) {
    optionalString(value, "progressSignature", `${path}.progressSignature`, issues);
  }
  if ("detail" in value && !isRecord(value.detail)) {
    issues.push({ path: `${path}.detail`, message: "Expected object" });
  }
}

export function validateOrchestratorEvent(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, ORCHESTRATOR_EVENT_FIELDS, issues, path);
  const protocolVersion = requiredInteger(
    value,
    "protocolVersion",
    `${path}.protocolVersion`,
    issues,
    { min: 1 }
  );
  if (protocolVersion !== undefined && protocolVersion !== 1) {
    issues.push({
      path: `${path}.protocolVersion`,
      message: "Expected orchestrator protocol version 1",
    });
  }
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredInteger(value, "sequence", `${path}.sequence`, issues, { min: 1 });
  requiredEnum(value, "type", `${path}.type`, ORCHESTRATOR_EVENT_TYPES, issues);
  requiredString(value, "sessionId", `${path}.sessionId`, issues, {
    nonEmpty: true,
  });
  if ("runId" in value) {
    optionalString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  }
  requiredString(value, "timestamp", `${path}.timestamp`, issues, {
    nonEmpty: true,
  });
  requiredRecord(value, "payload", `${path}.payload`, issues);
}

export function validateAgentEvent(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  requiredString(value, "type", `${path}.type`, issues, { nonEmpty: true });

  if ("sessionId" in value) {
    optionalString(value, "sessionId", `${path}.sessionId`, issues, {
      nonEmpty: true,
    });
  }

  if ("timestamp" in value) {
    optionalString(value, "timestamp", `${path}.timestamp`, issues, {
      nonEmpty: true,
    });
  }
}

export function validateMessageBase<const T extends readonly string[]>(
  value: unknown,
  allowedTypes: T
): ProtocolValidationResult<UnknownRecord & { type: T[number] }> {
  if (!isRecord(value)) {
    return invalid("Message must be a JSON object", [
      { path: "$", message: "Expected object" },
    ]);
  }

  const type = value.type;
  if (typeof type !== "string" || type.length === 0) {
    return invalid("Message type is required", [
      { path: "$.type", message: "Expected non-empty string" },
    ]);
  }

  if (!includesString(allowedTypes, type)) {
    return {
      ok: false,
      error: {
        code: "UNKNOWN_MESSAGE_TYPE",
        message: `Unknown message type: ${type}`,
        issues: [{ path: "$.type", message: `Unsupported message type: ${type}` }],
      },
    };
  }

  return ok(value as UnknownRecord & { type: T[number] });
}

function withMessageCorrelation<T extends DaemonInboundMessage | DaemonOutboundMessage>(
  input: UnknownRecord,
  result: ProtocolValidationResult<T>
): ProtocolValidationResult<T> {
  if (!result.ok) return result;

  const issues: ProtocolValidationIssue[] = [];
  const requestId = optionalString(input, "requestId", "$.requestId", issues, {
    nonEmpty: true,
  });
  const correlationId = optionalString(input, "correlationId", "$.correlationId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid message correlation", issues);
  if (requestId === undefined && correlationId === undefined) return result;

  return ok({
    ...result.value,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(correlationId !== undefined ? { correlationId } : {}),
  });
}

function rejectUnknownFields(
  input: UnknownRecord,
  allowedFields: readonly string[],
  issues: ProtocolValidationIssue[],
  path = "$"
): void {
  for (const key of Object.keys(input)) {
    if (!includesString(allowedFields, key)) {
      issues.push({
        path: path === "$" ? `$.${key}` : `${path}.${key}`,
        message: "Unexpected field",
      });
    }
  }
}

function requiredString(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { nonEmpty?: boolean } = {}
): string | undefined {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return undefined;
  }

  return readString(input[key], path, issues, options);
}

function optionalString(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { nonEmpty?: boolean } = {}
): string | undefined {
  if (!(key in input)) return undefined;
  return readString(input[key], path, issues, options);
}

export function validateOptionalNullableString(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { nonEmpty?: boolean } = {}
): void {
  if (!(key in input) || input[key] === null) return;
  readString(input[key], path, issues, options);
}

function readString(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { nonEmpty?: boolean }
): string | undefined {
  if (typeof value !== "string") {
    issues.push({ path, message: "Expected string" });
    return undefined;
  }

  if (options.nonEmpty && value.length === 0) {
    issues.push({ path, message: "Expected non-empty string" });
    return undefined;
  }

  return value;
}

function requiredInteger(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { min?: number } = {}
): number | undefined {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return undefined;
  }

  return readInteger(input[key], path, issues, options);
}

function optionalInteger(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { min?: number } = {}
): number | undefined {
  if (!(key in input)) return undefined;
  return readInteger(input[key], path, issues, options);
}

function requiredNumber(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { min?: number; max?: number } = {}
): number | undefined {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return undefined;
  }
  return readNumber(input[key], path, issues, options);
}

function optionalNumber(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { min?: number; max?: number } = {}
): number | undefined {
  if (!(key in input)) return undefined;
  return readNumber(input[key], path, issues, options);
}

function readNumber(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { min?: number; max?: number } = {}
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push({ path, message: "Expected number" });
    return undefined;
  }
  if (options.min !== undefined && value < options.min) {
    issues.push({ path, message: `Expected number >= ${options.min}` });
    return undefined;
  }
  if (options.max !== undefined && value > options.max) {
    issues.push({ path, message: `Expected number <= ${options.max}` });
    return undefined;
  }
  return value;
}

function optionalNullableNumber(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): number | null | undefined {
  if (!(key in input)) return undefined;
  if (input[key] === null) return null;
  return optionalNumber(input, key, path, issues);
}

function requiredNullableInteger(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { min?: number } = {}
): number | null | undefined {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return undefined;
  }
  if (input[key] === null) return null;
  return readInteger(input[key], path, issues, options);
}

function optionalBoolean(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): boolean | undefined {
  if (!(key in input)) return undefined;
  if (typeof input[key] !== "boolean") {
    issues.push({ path, message: "Expected boolean" });
    return undefined;
  }
  return input[key];
}

function requiredBoolean(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): boolean | undefined {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return undefined;
  }
  if (typeof input[key] !== "boolean") {
    issues.push({ path, message: "Expected boolean" });
    return undefined;
  }
  return input[key];
}

function optionalNullableString(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): string | null | undefined {
  if (!(key in input)) return undefined;
  return readNullableString(input[key], path, issues);
}

function requiredNullableString(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): string | null | undefined {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return undefined;
  }
  return readNullableString(input[key], path, issues);
}

function readNullableString(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") {
    issues.push({ path, message: "Expected string or null" });
    return undefined;
  }
  if (value.length === 0) {
    issues.push({ path, message: "Expected non-empty string or null" });
    return undefined;
  }
  return value;
}

function requiredWorkflowSchedule(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): CreateWorkflowMessage["schedule"] | undefined {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return undefined;
  }
  return readWorkflowSchedule(input[key], path, issues);
}

function optionalWorkflowSchedule(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): CreateWorkflowMessage["schedule"] | undefined {
  if (!(key in input)) return undefined;
  return readWorkflowSchedule(input[key], path, issues);
}

function readWorkflowSchedule(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): CreateWorkflowMessage["schedule"] | undefined {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return undefined;
  }

  const type = requiredEnum(value, "type", `${path}.type`, WORKFLOW_SCHEDULE_TYPES, issues);
  if (type === undefined) return undefined;

  if (type === "manual") {
    rejectUnknownFields(value, ["type"], issues, path);
    return { type };
  }

  if (type === "daily") {
    rejectUnknownFields(value, ["type", "time", "timezone"], issues, path);
    const time = requiredString(value, "time", `${path}.time`, issues, {
      nonEmpty: true,
    });
    const timezone = requiredString(value, "timezone", `${path}.timezone`, issues, {
      nonEmpty: true,
    });
    if (typeof time === "string" && !isDailyTime(time)) {
      issues.push({ path: `${path}.time`, message: "Expected HH:mm" });
    }
    if (typeof timezone === "string" && !isValidTimeZone(timezone)) {
      issues.push({ path: `${path}.timezone`, message: "Expected valid IANA timezone" });
    }
    return {
      type,
      time: time as string,
      timezone: timezone as string,
    };
  }

  rejectUnknownFields(value, ["type", "intervalMinutes"], issues, path);
  const intervalMinutes = requiredInteger(
    value,
    "intervalMinutes",
    `${path}.intervalMinutes`,
    issues,
    { min: 1 }
  );
  return {
    type,
    intervalMinutes: intervalMinutes as number,
  };
}

function optionalJsonObject(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): JsonObject | undefined {
  if (!(key in input)) return undefined;
  if (!isJsonObject(input[key])) {
    issues.push({ path, message: "Expected JSON object" });
    return undefined;
  }
  return input[key] as JsonObject;
}

function requiredEventLogMetadata(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): SessionEventsMessage["eventLog"] | undefined {
  const value = requiredRecord(input, key, path, issues);
  if (!value) return undefined;
  return readEventLogMetadata(value, path, issues);
}

function readEventLogMetadata(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): SessionEventsMessage["eventLog"] | undefined {
  rejectUnknownFields(value, ["eventLogId", "generation", "schemaVersion", "protocolVersion"], issues, path);
  const eventLogId = requiredString(value, "eventLogId", `${path}.eventLogId`, issues, { nonEmpty: true });
  const generation = requiredInteger(value, "generation", `${path}.generation`, issues, { min: 1 });
  const schemaVersion = requiredInteger(value, "schemaVersion", `${path}.schemaVersion`, issues, { min: 1 });
  const protocolVersion = requiredInteger(value, "protocolVersion", `${path}.protocolVersion`, issues, { min: 1 });
  if (schemaVersion !== undefined && schemaVersion !== 1) {
    issues.push({ path: `${path}.schemaVersion`, message: "Expected 1" });
  }
  if (protocolVersion !== undefined && protocolVersion !== 1) {
    issues.push({ path: `${path}.protocolVersion`, message: "Expected 1" });
  }
  if (eventLogId === undefined || generation === undefined || schemaVersion === undefined || protocolVersion === undefined) {
    return undefined;
  }
  return { eventLogId, generation, schemaVersion: schemaVersion as 1, protocolVersion: protocolVersion as 1 };
}

function optionalEventReplayCursor(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): DaemonEventReplayCursor | undefined {
  if (!(key in input)) return undefined;
  if (!isRecord(input[key])) {
    issues.push({ path, message: "Expected object" });
    return undefined;
  }
  return readEventReplayCursor(input[key], path, issues);
}

function readEventReplayCursor(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): DaemonEventReplayCursor | undefined {
  rejectUnknownFields(value, ["eventLogId", "generation", "schemaVersion", "protocolVersion", "afterSequence", "lastEventId"], issues, path);
  const eventLogId = requiredString(value, "eventLogId", `${path}.eventLogId`, issues, { nonEmpty: true });
  const generation = requiredInteger(value, "generation", `${path}.generation`, issues, { min: 1 });
  const schemaVersion = requiredInteger(value, "schemaVersion", `${path}.schemaVersion`, issues, { min: 1 });
  const protocolVersion = requiredInteger(value, "protocolVersion", `${path}.protocolVersion`, issues, { min: 1 });
  const afterSequence = requiredInteger(value, "afterSequence", `${path}.afterSequence`, issues, { min: 0 });
  const lastEventId = optionalString(value, "lastEventId", `${path}.lastEventId`, issues, { nonEmpty: true });
  if (
    eventLogId === undefined ||
    generation === undefined ||
    schemaVersion === undefined ||
    protocolVersion === undefined ||
    afterSequence === undefined
  ) {
    return undefined;
  }
  return {
    eventLogId,
    generation,
    schemaVersion,
    protocolVersion,
    afterSequence,
    ...(lastEventId !== undefined ? { lastEventId } : {}),
  };
}

function optionalEventCursorDiagnostic(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): DaemonEventCursorDiagnostic | undefined {
  if (!(key in input)) return undefined;
  if (!isRecord(input[key])) {
    issues.push({ path, message: "Expected object" });
    return undefined;
  }
  const value = input[key];
  rejectUnknownFields(value, ["code", "message", "severity", "previous", "current", "replayedFromSequence"], issues, path);
  const code = requiredString(value, "code", `${path}.code`, issues, { nonEmpty: true });
  if (code !== undefined && code !== "EVENT_LOG_CURSOR_MISMATCH") {
    issues.push({ path: `${path}.code`, message: "Expected EVENT_LOG_CURSOR_MISMATCH" });
  }
  const message = requiredString(value, "message", `${path}.message`, issues, { nonEmpty: true });
  const severity = requiredString(value, "severity", `${path}.severity`, issues, { nonEmpty: true });
  if (severity !== undefined && severity !== "warning") {
    issues.push({ path: `${path}.severity`, message: "Expected warning" });
  }
  const previous = optionalEventReplayCursor(value, "previous", `${path}.previous`, issues);
  const current = requiredEventLogMetadata(value, "current", `${path}.current`, issues);
  const replayedFromSequence = requiredInteger(value, "replayedFromSequence", `${path}.replayedFromSequence`, issues, { min: 0 });
  if (
    code !== "EVENT_LOG_CURSOR_MISMATCH" ||
    message === undefined ||
    severity !== "warning" ||
    current === undefined ||
    replayedFromSequence === undefined
  ) {
    return undefined;
  }
  return {
    code,
    message,
    severity,
    ...(previous !== undefined ? { previous } : {}),
    current,
    replayedFromSequence,
  };
}

export function validateEventReadDiagnostics(
  input: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(input)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(
    input,
    [
      "mode",
      "requestedAfterSequence",
      "storeReadAfterSequence",
      "projectedAfterSequence",
      "eventsFetched",
      "eventsReturned",
      "truncated",
      "maxEvents",
      "queryMs",
    ],
    issues,
    path
  );
  requiredEnum(input, "mode", `${path}.mode`, ["incremental", "full-replay", "cursor-replay"] as const, issues);
  requiredInteger(input, "requestedAfterSequence", `${path}.requestedAfterSequence`, issues, { min: 0 });
  requiredInteger(input, "storeReadAfterSequence", `${path}.storeReadAfterSequence`, issues, { min: 0 });
  requiredInteger(input, "projectedAfterSequence", `${path}.projectedAfterSequence`, issues, { min: 0 });
  requiredInteger(input, "eventsFetched", `${path}.eventsFetched`, issues, { min: 0 });
  if ("eventsReturned" in input) {
    optionalInteger(input, "eventsReturned", `${path}.eventsReturned`, issues, { min: 0 });
  }
  if ("truncated" in input) {
    optionalBoolean(input, "truncated", `${path}.truncated`, issues);
  }
  if ("maxEvents" in input) {
    optionalInteger(input, "maxEvents", `${path}.maxEvents`, issues, { min: 1 });
  }
  requiredInteger(input, "queryMs", `${path}.queryMs`, issues, { min: 0 });
}

export function validateSessionListDiagnostics(
  input: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(input)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(
    input,
    ["queryMs", "sessionCount", "summaryCount", "metadataCount", "filteredOutCount", "summarySource"],
    issues,
    path
  );
  requiredInteger(input, "queryMs", `${path}.queryMs`, issues, { min: 0 });
  requiredInteger(input, "sessionCount", `${path}.sessionCount`, issues, { min: 0 });
  requiredInteger(input, "summaryCount", `${path}.summaryCount`, issues, { min: 0 });
  requiredInteger(input, "metadataCount", `${path}.metadataCount`, issues, { min: 0 });
  requiredInteger(input, "filteredOutCount", `${path}.filteredOutCount`, issues, { min: 0 });
  requiredEnum(input, "summarySource", `${path}.summarySource`, ["event-store", "unavailable"] as const, issues);
}

function readInteger(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { min?: number }
): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    issues.push({ path, message: "Expected integer" });
    return undefined;
  }

  if (options.min !== undefined && value < options.min) {
    issues.push({ path, message: `Expected integer >= ${options.min}` });
    return undefined;
  }

  return value;
}

function requiredRecord(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): UnknownRecord | undefined {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return undefined;
  }

  if (!isRecord(input[key])) {
    issues.push({ path, message: "Expected object" });
    return undefined;
  }

  return input[key] as UnknownRecord;
}

function requiredArray(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): unknown[] | undefined {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return undefined;
  }

  if (!Array.isArray(input[key])) {
    issues.push({ path, message: "Expected array" });
    return undefined;
  }

  return input[key];
}

function optionalArray(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): unknown[] | undefined {
  if (!(key in input)) return undefined;
  if (!Array.isArray(input[key])) {
    issues.push({ path, message: "Expected array" });
    return undefined;
  }
  return input[key];
}

function requiredPlanDocumentPatch(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): PatchPlanDocumentMessage["patch"] | undefined {
  const patch = requiredRecord(input, key, path, issues);
  if (!patch) return undefined;

  rejectUnknownFields(patch, ["expectedVersion", "operations"], issues, path);
  optionalInteger(patch, "expectedVersion", `${path}.expectedVersion`, issues, { min: 1 });
  const operations = requiredArray(patch, "operations", `${path}.operations`, issues);
  operations?.forEach((operation, index) => {
    if (!isRecord(operation)) {
      issues.push({ path: `${path}.operations[${index}]`, message: "Expected object" });
      return;
    }
    requiredString(operation, "op", `${path}.operations[${index}].op`, issues, {
      nonEmpty: true,
    });
  });

  return patch as unknown as PatchPlanDocumentMessage["patch"];
}

function requiredStringArray(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): string[] | undefined {
  const values = requiredArray(input, key, path, issues);
  if (!values) return undefined;
  values.forEach((value, index) => {
    if (typeof value !== "string" || value.length === 0) {
      issues.push({ path: `${path}[${index}]`, message: "Expected non-empty string" });
    }
  });
  return values as string[];
}

function optionalStringArray(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): string[] | undefined {
  if (!(key in input)) return undefined;
  if (!Array.isArray(input[key])) {
    issues.push({ path, message: "Expected array" });
    return undefined;
  }
  const values = input[key] as unknown[];
  values.forEach((value, index) => {
    if (typeof value !== "string" || value.length === 0) {
      issues.push({ path: `${path}[${index}]`, message: "Expected non-empty string" });
    }
  });
  return values as string[];
}

function requiredEnum<const T extends readonly string[]>(
  input: UnknownRecord,
  key: string,
  path: string,
  values: T,
  issues: ProtocolValidationIssue[]
): T[number] | undefined {
  if (!(key in input)) {
    issues.push({ path, message: "Required field is missing" });
    return undefined;
  }

  return readEnum(input[key], path, values, issues);
}

function optionalEnum<const T extends readonly string[]>(
  input: UnknownRecord,
  key: string,
  path: string,
  values: T,
  issues: ProtocolValidationIssue[]
): T[number] | undefined {
  if (!(key in input)) return undefined;
  return readEnum(input[key], path, values, issues);
}

function requiredApprovalProtocolStatus(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): (typeof APPROVAL_PROTOCOL_STATUSES)[number] | undefined {
  return requiredEnum(input, key, path, APPROVAL_PROTOCOL_STATUSES, issues);
}

function optionalApprovalProtocolStatus(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): (typeof APPROVAL_PROTOCOL_STATUSES)[number] | undefined {
  return optionalEnum(input, key, path, APPROVAL_PROTOCOL_STATUSES, issues);
}

function readEnum<const T extends readonly string[]>(
  value: unknown,
  path: string,
  values: T,
  issues: ProtocolValidationIssue[]
): T[number] | undefined {
  if (typeof value !== "string" || !includesString(values, value)) {
    issues.push({
      path,
      message: `Expected one of: ${values.join(", ")}`,
    });
    return undefined;
  }

  return value;
}

const isRecord = isRecordShared;

function includesString<const T extends readonly string[]>(
  values: T,
  value: string
): value is T[number] {
  return (values as readonly string[]).includes(value);
}

function ok<T>(value: T): ProtocolValidationResult<T> {
  return { ok: true, value };
}

function invalid<T = never>(
  message: string,
  issues: ProtocolValidationIssue[]
): ProtocolValidationResult<T> {
  return {
    ok: false,
    error: {
      code: "INVALID_MESSAGE",
      message,
      issues,
    },
  };
}
