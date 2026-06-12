/**
 * Protocol schema field definitions — constant arrays listing field names for
 * every message shape, helper record, and orchestrator event type.
 *
 * Extracted from schema.ts.  Consumed by domain validators (schema-inbound,
 * schema-outbound, schema-orchestrator, etc.) to reject unknown fields.
 */
import { CORRELATION_FIELDS } from "./schema-core";

// ─── Message / response / helper-record FIELDS ─────────────────────────────

export const RUN_TASK_FIELDS = [
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

export const APPROVE_TOOL_FIELDS = ["type", ...CORRELATION_FIELDS, "toolCallId", "scope"] as const;
export const DENY_TOOL_FIELDS = ["type", ...CORRELATION_FIELDS, "toolCallId"] as const;
export const LIST_APPROVAL_HISTORY_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "sessionId",
  "runId",
  "toolName",
  "status",
  "decision",
  "risk",
  "limit",
] as const;
export const CANCEL_RUN_FIELDS = ["type", ...CORRELATION_FIELDS, "runId"] as const;
export const EMPTY_COMMAND_FIELDS = ["type", ...CORRELATION_FIELDS] as const;
export const LIST_SESSIONS_FIELDS = ["type", ...CORRELATION_FIELDS, "includeArchived", "includeDeleted"] as const;
export const UPDATE_CONFIG_FIELDS = ["type", ...CORRELATION_FIELDS, "apiKey", "baseUrl", "model", "credentialMode", "endpoint", "stream"] as const;
export const LIST_RUNS_FIELDS = ["type", ...CORRELATION_FIELDS, "sessionId"] as const;
export const READ_SESSION_EVENTS_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "sessionId",
  "afterSequence",
  "lastEventId",
  "maxEvents",
  "cursor",
] as const;
export const READ_RUN_EVENTS_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "runId",
  "afterSequence",
  "lastEventId",
  "includeSnapshot",
  "maxEvents",
  "cursor",
] as const;
export const GET_RUN_SNAPSHOT_FIELDS = ["type", ...CORRELATION_FIELDS, "runId"] as const;
export const GET_METRICS_FIELDS = ["type", ...CORRELATION_FIELDS, "runId", "sessionId", "includeRuns"] as const;
export const CREATE_WORKFLOW_FIELDS = [
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
export const UPDATE_WORKFLOW_FIELDS = [
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
export const DELETE_WORKFLOW_FIELDS = ["type", ...CORRELATION_FIELDS, "workflowId"] as const;
export const TRIGGER_WORKFLOW_FIELDS = ["type", ...CORRELATION_FIELDS, "workflowId", "runId", "sessionId"] as const;
export const LIST_WORKFLOW_RUNS_FIELDS = ["type", ...CORRELATION_FIELDS, "workflowId"] as const;
export const GIT_STATUS_FIELDS = ["type", ...CORRELATION_FIELDS, "cwd"] as const;
export const GIT_DIFF_FIELDS = ["type", ...CORRELATION_FIELDS, "cwd", "path", "staged"] as const;
export const CREATE_PLAN_DOCUMENT_FIELDS = [
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
export const CREATE_REQUIREMENTS_ALIGNMENT_PLAN_FIELDS = [
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
export const GET_PLAN_DOCUMENT_FIELDS = ["type", ...CORRELATION_FIELDS, "documentId"] as const;
export const PATCH_PLAN_DOCUMENT_FIELDS = ["type", ...CORRELATION_FIELDS, "documentId", "patch"] as const;
export const DELETE_PLAN_DOCUMENT_FIELDS = ["type", ...CORRELATION_FIELDS, "documentId"] as const;
export const LIST_MUTATION_LEASES_FIELDS = ["type", ...CORRELATION_FIELDS, "cwd"] as const;
export const LIST_BACKGROUND_TASKS_FIELDS = ["type", ...CORRELATION_FIELDS, "includeHistory", "state", "limit"] as const;
export const START_BACKGROUND_TASK_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "command",
  "cwd",
  "workspaceRoot",
  "timeoutMs",
  "maxOutputBytes",
  "heartbeatIntervalMs",
] as const;
export const CANCEL_BACKGROUND_TASK_FIELDS = ["type", ...CORRELATION_FIELDS, "taskId"] as const;
export const GET_BACKGROUND_TASK_HISTORY_FIELDS = ["type", ...CORRELATION_FIELDS, "state", "limit"] as const;
export const LIST_ARTIFACTS_FIELDS = ["type", ...CORRELATION_FIELDS, "sessionId"] as const;
export const GET_ARTIFACT_CONTENT_FIELDS = ["type", ...CORRELATION_FIELDS, "artifactUri"] as const;
export const LIST_MEMORIES_FIELDS = ["type", ...CORRELATION_FIELDS, "scope"] as const;
export const DELETE_MEMORY_FIELDS = ["type", ...CORRELATION_FIELDS, "memoryId"] as const;
export const LIST_CHECKPOINTS_FIELDS = ["type", ...CORRELATION_FIELDS, "runId", "sessionId"] as const;
export const RESTORE_CHECKPOINT_FIELDS = ["type", ...CORRELATION_FIELDS, "checkpointId"] as const;
export const GET_CHECKPOINT_DIFF_FIELDS = ["type", ...CORRELATION_FIELDS, "checkpointId"] as const;
export const CONVERSATION_REWIND_BOUNDARY_REQUEST_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "sessionId",
  "userMessageId",
  "latestUserMessage",
  "mode",
] as const;
export const PREVIEW_CONVERSATION_REWIND_BY_BOUNDARY_FIELDS = [
  ...CONVERSATION_REWIND_BOUNDARY_REQUEST_FIELDS,
  "restorePolicy",
  "activeSubagents",
] as const;
export const CONVERSATION_REWIND_REQUEST_FIELDS = [
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
export const APPLY_SESSION_ACTION_FIELDS = ["type", ...CORRELATION_FIELDS, "action"] as const;
export const ENQUEUE_PENDING_INPUT_FIELDS = [
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
export const CANCEL_PENDING_INPUT_FIELDS = ["type", ...CORRELATION_FIELDS, "inputId", "sessionId", "reason"] as const;
export const DISPATCH_PENDING_INPUT_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "inputId",
  "sessionId",
  "targetRunId",
] as const;
export const LIST_PENDING_INPUTS_FIELDS = ["type", ...CORRELATION_FIELDS, "sessionId"] as const;
export const PENDING_INPUT_RECORD_FIELDS = [
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
export const PENDING_INPUT_QUEUED_FIELDS = ["type", ...CORRELATION_FIELDS, "input", "event"] as const;
export const PENDING_INPUT_CANCELLED_FIELDS = ["type", ...CORRELATION_FIELDS, "input", "event"] as const;
export const PENDING_INPUT_DISPATCHED_FIELDS = ["type", ...CORRELATION_FIELDS, "input", "event"] as const;
export const PENDING_INPUTS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "inputs", "sessionId"] as const;
export const SESSION_ACTION_BASE_FIELDS = [
  "protocolVersion",
  "actionId",
  "kind",
  "sessionId",
  "requestedAt",
  "requestedBy",
  "idempotencyKey",
  "consistency",
] as const;
export const SESSION_ACTION_CONSISTENCY_FIELDS = [
  "expectedSessionVersion",
  "eventLogCursor",
  "workspaceVersionId",
  "parentActionId",
] as const;
export const SESSION_ACTION_RECEIPT_FIELDS = [
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

export const DAEMON_READY_FIELDS = ["type", "port", "protocolVersion", "buildHash"] as const;
export const EVENT_FIELDS = ["type", "runId", "event"] as const;
export const APPROVAL_REQUESTED_FIELDS = [
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
export const APPROVAL_RESOLVED_FIELDS = ["type", "toolCallId", "decision", "reason", "expiredAt"] as const;
export const APPROVAL_HISTORY_LISTED_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "approvals",
  "eventLog",
  "filters",
  "total",
  "returned",
  "truncated",
  "diagnostics",
] as const;
export const APPROVAL_HISTORY_FILTERS_FIELDS = ["sessionId", "runId", "toolName", "status", "risk"] as const;
export const APPROVAL_HISTORY_ENTRY_FIELDS = [
  "toolCallId",
  "runId",
  "sessionId",
  "toolName",
  "summary",
  "input",
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
  "requestSequence",
  "resolvedSequence",
  "source",
  "live",
  "updatedAt",
] as const;
export const APPROVAL_HISTORY_DIAGNOSTICS_FIELDS = [
  "queryMs",
  "eventCount",
  "projectedCount",
  "liveOverlayCount",
  "filteredOutCount",
  "limit",
  "truncated",
] as const;
export const ERROR_FIELDS = ["type", ...CORRELATION_FIELDS, "code", "message", "runId"] as const;
export const STATUS_RESPONSE_FIELDS = [
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
export const CAPABILITIES_RESPONSE_FIELDS = ["type", ...CORRELATION_FIELDS, "snapshot"] as const;
export const CAPABILITY_SNAPSHOT_FIELDS = ["schemaVersion", "generatedAt", "capabilities"] as const;
export const CAPABILITY_RECORD_FIELDS = [
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
export const CAPABILITY_DIAGNOSTIC_FIELDS = [
  "code",
  "message",
  "severity",
  "updatedAt",
  "detail",
  "metadata",
] as const;
export const LIFECYCLE_FIELDS = [
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
export const CLIENT_DISCONNECT_FIELDS = [
  "clientId",
  "code",
  "reason",
  "connectedAt",
  "disconnectedAt",
  "durationMs",
] as const;
export const EVENT_STORE_STATUS_FIELDS = ["status", "path", "failure"] as const;
export const LIFECYCLE_DIAGNOSTIC_FIELDS = [
  "code",
  "message",
  "updatedAt",
  "source",
  "severity",
  "detail",
  "metadata",
] as const;
export const ACTIVE_RUN_FIELDS = ["runId", "prompt", "status", "startedAt", "cwd"] as const;
export const PENDING_APPROVAL_FIELDS = [
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
export const PROVIDER_STATUS_FIELDS = [
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
  "accountCenter",
  "gateway",
  "lastDiagnostic",
  "updatedAt",
] as const;
export const PROVIDER_REDACTED_API_KEY_FIELDS = ["hasApiKey", "source", "last4"] as const;
export const ACCOUNT_CENTER_STATUS_FIELDS = [
  "configured",
  "accountId",
  "login",
  "quota",
  "gateway",
  "runtimeCredential",
  "lastCheckedAt",
  "lastDiagnostic",
] as const;
export const PROVIDER_GATEWAY_STATUS_FIELDS = [
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
export const PROVIDER_DIAGNOSTIC_FIELDS = [
  "code",
  "message",
  "updatedAt",
  "kind",
  "status",
  "detail",
  "metadata",
] as const;
export const MCP_STATUS_FIELDS = [
  "configured",
  "readiness",
  "serverCount",
  "summary",
  "diagnostics",
  "servers",
  "updatedAt",
] as const;
export const CONFIG_UPDATED_FIELDS = ["type", ...CORRELATION_FIELDS, "updatedFields"] as const;
export const SUBAGENT_STARTED_FIELDS = [
  "type",
  "runId",
  "subagentId",
  "subagentRunId",
  "parentToolCallId",
  "description",
  "mode",
] as const;
export const SUBAGENT_ENDED_FIELDS = [
  "type",
  "runId",
  "subagentId",
  "subagentRunId",
  "parentToolCallId",
  "status",
  "summary",
] as const;
export const SUBAGENT_EVENT_FIELDS = [
  "type",
  "runId",
  "subagentId",
  "subagentRunId",
  "parentToolCallId",
  "event",
] as const;
export const SESSIONS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "sessions", "summaries", "eventLog", "diagnostics"] as const;
export const RUNS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "runs", "sessionId"] as const;
export const SESSION_EVENTS_FIELDS = [
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
export const RUN_EVENTS_FIELDS = [
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
export const RUN_SNAPSHOT_FIELDS = ["type", ...CORRELATION_FIELDS, "runId", "snapshot"] as const;
export const METRICS_RESPONSE_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "status",
  "query",
  "source",
  "summary",
  "runs",
  "diagnostic",
] as const;
export const WORKFLOWS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "workflows"] as const;
export const WORKFLOW_CREATED_FIELDS = ["type", ...CORRELATION_FIELDS, "workflow"] as const;
export const WORKFLOW_UPDATED_FIELDS = ["type", ...CORRELATION_FIELDS, "workflow"] as const;
export const WORKFLOW_DELETED_FIELDS = ["type", ...CORRELATION_FIELDS, "workflowId"] as const;
export const WORKFLOW_TRIGGERED_FIELDS = ["type", ...CORRELATION_FIELDS, "accepted", "runId", "workflowRunId", "run"] as const;
export const WORKFLOW_RUN_UPDATED_FIELDS = ["type", ...CORRELATION_FIELDS, "runId", "workflowRunId", "workflowId", "run"] as const;
export const WORKFLOW_RUNS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "runs", "workflowId"] as const;
export const GIT_STATUS_RESPONSE_FIELDS = [
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
export const GIT_STATUS_FILE_FIELDS = [
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
export const GIT_DIFF_RESPONSE_FIELDS = [
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
export const PLAN_DOCUMENTS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "documents"] as const;
export const PLAN_DOCUMENT_MESSAGE_FIELDS = ["type", ...CORRELATION_FIELDS, "document"] as const;
export const PLAN_DOCUMENT_DELETED_FIELDS = ["type", ...CORRELATION_FIELDS, "documentId"] as const;
export const MUTATION_LEASES_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "leases"] as const;
export const BACKGROUND_TASKS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "tasks", "diagnostics"] as const;
export const BACKGROUND_TASK_SINGLE_FIELDS = ["type", ...CORRELATION_FIELDS, "task", "diagnostics"] as const;
export const ARTIFACTS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "artifacts"] as const;
export const ARTIFACT_CONTENT_FIELDS = ["type", ...CORRELATION_FIELDS, "artifactUri", "content", "mimeType"] as const;
export const MEMORIES_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "memories"] as const;
export const MEMORY_DELETED_FIELDS = ["type", ...CORRELATION_FIELDS, "memoryId"] as const;
export const CHECKPOINTS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "checkpoints"] as const;
export const CHECKPOINT_DIFF_FIELDS = ["type", ...CORRELATION_FIELDS, "checkpointId", "files"] as const;
export const CHECKPOINT_RESTORED_FIELDS = ["type", ...CORRELATION_FIELDS, "checkpointId", "runId"] as const;
export const CONVERSATION_REWIND_BOUNDARY_FIELDS = [
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
export const CONVERSATION_REWIND_PREVIEW_FIELDS = ["type", ...CORRELATION_FIELDS, "sessionId", "plan"] as const;
export const CONVERSATION_REWIND_APPLIED_FIELDS = [
  "type",
  ...CORRELATION_FIELDS,
  "sessionId",
  "plan",
  "stepResults",
] as const;
export const CONVERSATION_REWIND_STEP_RESULT_FIELDS = ["type", "status", "code", "message", "affectedIds", "metadata"] as const;
export const SESSION_TREE_ENTRY_FIELDS = [
  "type",
  "id",
  "parentId",
  "createdAt",
  "payload",
  "summary",
  "abandonedLeafId",
  "details",
] as const;
export const REWIND_CHECKPOINT_FIELDS = ["source", "checkpointId", "manifestPath", "checkpoint", "cleanUntracked"] as const;
export const REWIND_ACTIVE_SUBAGENT_FIELDS = ["parentRunId", "subagentRunId", "subagentId"] as const;
export const REWIND_BOUNDARY_RECORD_FIELDS = [
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
export const REWIND_CHECKPOINT_RECORD_FIELDS = [
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
export const REWIND_CHECKPOINT_TOOL_CALL_FIELDS = ["id", "toolName", "actor", "sessionId", "targetSummary"] as const;
export const REWIND_TARGET_FACTS_FIELDS = [
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
export const REWIND_TARGET_CHECKPOINT_FACTS_FIELDS = [
  "checkpointId",
  "checkpointRef",
  "checkpointSource",
  "workspaceRoot",
  "changedPaths",
  "createdAt",
] as const;
export const REWIND_BOUNDARY_DIAGNOSTIC_FIELDS = ["code", "fact", "message", "blocked", "metadata"] as const;
export const REWIND_PLAN_FIELDS = [
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
export const REWIND_ENTRY_PROJECTION_FIELDS = [
  "currentPath",
  "targetPath",
  "commonAncestorId",
  "retainedEntryIds",
  "hiddenEntryIds",
  "hiddenCurrentPathEntryIds",
  "hiddenBranchEntryIds",
] as const;
export const REWIND_RUN_CANCELLATION_FIELDS = ["runId", "reason", "role"] as const;
export const REWIND_APPROVAL_CLEARANCE_FIELDS = ["toolCallId", "runId", "reason"] as const;
export const REWIND_WORKSPACE_RESTORE_FIELDS = [
  "required",
  "source",
  "checkpointId",
  "checkpoint",
  "manifestPath",
  "cleanUntracked",
] as const;
export const REWIND_STEP_FIELDS = ["type", "runs", "approvals", "restore", "sessionId", "fromLeafId", "toLeafId"] as const;
export const MUTATION_LEASE_FIELDS = [
  "token",
  "scope",
  "owner",
  "createdAt",
  "expiresAt",
  "ttlMs",
] as const;
export const MUTATION_LEASE_OWNER_FIELDS = [
  "runId",
  "sessionId",
  "toolCallId",
  "toolName",
  "cwd",
  "targetSummary",
] as const;
export const BACKGROUND_TASK_FIELDS = [
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
export const BACKGROUND_TASK_DIAGNOSTIC_FIELDS = [
  "code",
  "message",
  "severity",
  "updatedAt",
  "detail",
  "metadata",
] as const;
export const ARTIFACT_RECORD_FIELDS = ["uri", "type", "name", "size", "createdAt", "sessionId", "runId"] as const;
export const MEMORY_RECORD_FIELDS = ["id", "key", "value", "scope", "createdAt", "updatedAt"] as const;
export const CHECKPOINT_RECORD_FIELDS = ["id", "runId", "sessionId", "label", "createdAt", "messageCount"] as const;
export const CHANGED_FILE_RECORD_FIELDS = ["path", "status", "addedLines", "removedLines"] as const;
export const SEND_TO_SUBAGENT_FIELDS = ["type", ...CORRELATION_FIELDS, "subagentRunId", "message"] as const;
export const GET_SUBAGENT_STATUS_FIELDS = ["type", ...CORRELATION_FIELDS, "subagentRunId"] as const;
export const MCP_SERVER_CONTROL_FIELDS = ["type", ...CORRELATION_FIELDS, "serverId"] as const;
export const MCP_SERVERS_LISTED_FIELDS = ["type", ...CORRELATION_FIELDS, "servers"] as const;
export const MCP_SERVER_STARTED_FIELDS = ["type", ...CORRELATION_FIELDS, "serverId", "state"] as const;
export const MCP_SERVER_STOPPED_FIELDS = ["type", ...CORRELATION_FIELDS, "serverId", "state"] as const;
export const GET_SCOPED_CONTEXT_FIELDS = ["type", ...CORRELATION_FIELDS, "scope", "kind"] as const;
export const UPSERT_SCOPED_CONTEXT_FIELDS = ["type", ...CORRELATION_FIELDS, "record"] as const;
export const DELETE_SCOPED_CONTEXT_FIELDS = ["type", ...CORRELATION_FIELDS, "recordId"] as const;
export const RESOLVE_SCOPED_CONTEXT_FIELDS = [
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
export const SCOPED_CONTEXT_RUNTIME_CONFIG_FIELDS = [
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
export const MCP_SERVER_RECORD_FIELDS = [
  "id",
  "name",
  "state",
  "transport",
  "cachedToolCount",
  "lastError",
  "startedAt",
] as const;
export const SUBAGENT_MESSAGE_SENT_FIELDS = ["type", ...CORRELATION_FIELDS, "subagentRunId", "accepted"] as const;
export const SUBAGENT_STATUS_FIELDS = ["type", ...CORRELATION_FIELDS, "subagentRunId", "status", "progress", "latestError"] as const;
export const SCOPED_CONTEXT_RESPONSE_FIELDS = ["type", ...CORRELATION_FIELDS, "status", "records", "diagnostic"] as const;
export const SCOPED_CONTEXT_UPSERTED_FIELDS = ["type", ...CORRELATION_FIELDS, "status", "record", "persisted", "diagnostic"] as const;
export const SCOPED_CONTEXT_DELETED_FIELDS = ["type", ...CORRELATION_FIELDS, "status", "recordId", "deleted", "diagnostic"] as const;
export const SCOPED_CONTEXT_RESOLVED_FIELDS = [
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
export const SCOPED_CONTEXT_RECORD_FIELDS = [
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
export const SCOPED_CONTEXT_SOURCE_FIELDS = ["type", "path", "label"] as const;
export const SCOPED_CONTEXT_DIAGNOSTIC_FIELDS = ["code", "message", "updatedAt", "path", "detail"] as const;
export const SCOPED_CONTEXT_CANDIDATE_FIELDS = [
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
export const SCOPED_CONTEXT_ITEM_FIELDS = [...SCOPED_CONTEXT_CANDIDATE_FIELDS, "status"] as const;
export const SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_FIELDS = ["severity", "id", "code", "message"] as const;
export const SCOPED_CONTEXT_RESOURCE_DIAGNOSTIC_FIELDS = ["severity", "path", "message"] as const;
export const PROMPT_CONTEXT_BLOCK_FIELDS = ["id", "kind", "label", "content"] as const;
export const WORKFLOW_FIELDS = [
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
export const WORKFLOW_RUN_FIELDS = [
  "workflowId",
  "runId",
  "sessionId",
  "scheduledFor",
  "startedAt",
  "status",
  "error",
] as const;
export const PLAN_DOCUMENT_SUMMARY_FIELDS = [
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
export const TASK_SNAPSHOT_FIELDS = [
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
export const TASK_MESSAGE_FIELDS = ["id", "role", "content", "createdAt", "toolCalls"] as const;
export const TASK_TOOL_CALL_FIELDS = [
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
export const TASK_APPROVAL_FIELDS = [
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
export const TASK_PROGRESS_FIELDS = [
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
export const TASK_USAGE_FIELDS = [
  "sampleCount",
  "promptTokens",
  "completionTokens",
  "totalTokens",
  "reasoningTokens",
] as const;
export const TASK_CACHE_FIELDS = [
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
export const TASK_BACKGROUND_TASK_FIELDS = [
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
export const TASK_CURRENT_RUN_FIELDS = ["id", "sessionId", "cwd", "createdAt", "updatedAt", "startedAt", "finishedAt", "metadata"] as const;
export const SESSION_RECORD_FIELDS = [
  "id",
  "cwd",
  "createdAt",
  "updatedAt",
  "status",
  "currentLeafId",
  "metadata",
] as const;
export const RUN_RECORD_FIELDS = [
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
export const ORCHESTRATOR_EVENT_FIELDS = [
  "protocolVersion",
  "id",
  "sequence",
  "type",
  "sessionId",
  "runId",
  "timestamp",
  "payload",
] as const;

// ─── Goal state / decision (orchestrator domain) ───────────────────────────

export const GOAL_STATE_FIELDS = [
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
export const GOAL_DECISION_FIELDS = ["action", "reason", "prompt", "progressSignature", "detail"] as const;

// ─── Orchestrator event type enum ──────────────────────────────────────────

export const ORCHESTRATOR_EVENT_TYPES = [
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
