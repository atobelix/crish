import {
  DAEMON_INBOUND_MESSAGE_TYPES,
  DAEMON_OUTBOUND_MESSAGE_TYPES,
} from '../registry.js';

export const INBOUND_MESSAGE_TYPES = DAEMON_INBOUND_MESSAGE_TYPES;
export const OUTBOUND_MESSAGE_TYPES = DAEMON_OUTBOUND_MESSAGE_TYPES;

export const CORRELATION_FIELDS = ['requestId', 'correlationId'] as const;

export const RUN_TASK_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'runId',
  'sessionId',
  'prompt',
  'mode',
  'workspaceMode',
  'cwd',
  'visibleGoal',
  'budgetDifficulty',
  'runTokenBudget',
  'maxRounds',
  'maxStalledRounds',
  'backgroundDrainTimeoutMs',
  'permissionMode',
  'workspaceRoot',
  'projectRoot',
  'projectMarkers',
  'projectFiles',
  'projectTags',
  'packageNames',
  'mcpDisabledTools',
  'scopedContextConfig',
  // 多模态轻量扩展（desktop image parts）
  'content',
  'hasImages',
  'attachments',
  // responseStyle / desktop system guidance → runtime systemPrompt
  'systemPrompt',
] as const;

export const APPROVE_TOOL_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'toolCallId',
  'scope',
] as const;
export const DENY_TOOL_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'toolCallId',
] as const;
export const CANCEL_RUN_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'runId',
] as const;
export const STREAM_PAUSE_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'runId',
] as const;
export const STREAM_RESUME_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'runId',
] as const;
export const EMPTY_COMMAND_FIELDS = ['type', ...CORRELATION_FIELDS] as const;
export const LIST_SESSIONS_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'includeArchived',
  'includeDeleted',
] as const;
export const UPDATE_CONFIG_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'apiKey',
  'baseUrl',
  'model',
  'credentialMode',
  'endpoint',
  'stream',
  'mcpServers',
] as const;
export const PROBE_PROVIDER_MODELS_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'profileId',
  'baseUrl',
  'apiKey',
] as const;
export const PROBE_PROVIDER_CHAT_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'profileId',
  'baseUrl',
  'apiKey',
  'model',
] as const;
export const LIST_RUNS_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'sessionId',
] as const;
export const READ_SESSION_EVENTS_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'sessionId',
  'afterSequence',
  'lastEventId',
  'maxEvents',
  'cursor',
] as const;
export const READ_RUN_EVENTS_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'runId',
  'afterSequence',
  'lastEventId',
  'includeSnapshot',
  'maxEvents',
  'cursor',
] as const;
export const GET_RUN_SNAPSHOT_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'runId',
] as const;
export const CREATE_WORKFLOW_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'id',
  'name',
  'prompt',
  'cwd',
  'mode',
  'schedule',
  'enabled',
  'metadata',
] as const;
export const UPDATE_WORKFLOW_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'workflowId',
  'name',
  'prompt',
  'cwd',
  'mode',
  'schedule',
  'enabled',
  'metadata',
] as const;
export const DELETE_WORKFLOW_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'workflowId',
] as const;
export const TRIGGER_WORKFLOW_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'workflowId',
  'runId',
  'sessionId',
] as const;
export const LIST_WORKFLOW_RUNS_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'workflowId',
] as const;
export const GIT_STATUS_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'cwd',
] as const;
export const GIT_DIFF_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'cwd',
  'path',
  'staged',
] as const;
export const CREATE_PLAN_DOCUMENT_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'id',
  'title',
  'goal',
  'assumptions',
  'questions',
  'steps',
  'acceptance',
  'risks',
  'status',
  'version',
  'createdAt',
  'updatedAt',
  'metadata',
] as const;
export const CREATE_REQUIREMENTS_ALIGNMENT_PLAN_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'id',
  'title',
  'goal',
  'context',
  'questions',
  'assumptions',
  'acceptance',
  'risks',
  'source',
  'metadata',
] as const;
export const GET_PLAN_DOCUMENT_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'documentId',
] as const;
export const PATCH_PLAN_DOCUMENT_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'documentId',
  'patch',
] as const;
export const DELETE_PLAN_DOCUMENT_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'documentId',
] as const;
export const LIST_MUTATION_LEASES_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'cwd',
] as const;
export const LIST_BACKGROUND_TASKS_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'includeHistory',
  'state',
  'limit',
] as const;
export const START_BACKGROUND_TASK_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'command',
  'cwd',
  'workspaceRoot',
  'timeoutMs',
  'maxOutputBytes',
  'heartbeatIntervalMs',
] as const;
export const CANCEL_BACKGROUND_TASK_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'taskId',
] as const;
export const GET_BACKGROUND_TASK_HISTORY_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'state',
  'limit',
] as const;
export const LIST_ARTIFACTS_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'sessionId',
] as const;
export const GET_ARTIFACT_CONTENT_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'artifactUri',
] as const;
export const LIST_MEMORIES_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'scope',
] as const;
export const DELETE_MEMORY_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'memoryId',
] as const;
export const LIST_CHECKPOINTS_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'runId',
  'sessionId',
] as const;
export const RESTORE_CHECKPOINT_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'checkpointId',
] as const;
export const GET_CHECKPOINT_DIFF_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'checkpointId',
] as const;
export const CONVERSATION_REWIND_BOUNDARY_REQUEST_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'sessionId',
  'userMessageId',
  'latestUserMessage',
  'mode',
] as const;
export const PREVIEW_CONVERSATION_REWIND_BY_BOUNDARY_FIELDS = [
  ...CONVERSATION_REWIND_BOUNDARY_REQUEST_FIELDS,
  'restorePolicy',
  'activeSubagents',
] as const;
export const CONVERSATION_REWIND_REQUEST_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'sessionId',
  'targetLeafId',
  'entries',
  'userMessageId',
  'latestUserMessage',
  'mode',
  'checkpoint',
  'restorePolicy',
  'activeSubagents',
] as const;
export const APPLY_SESSION_ACTION_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'action',
] as const;
export const ENQUEUE_PENDING_INPUT_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'sessionId',
  'text',
  'runId',
  'mode',
  'inputId',
  'source',
  'metadata',
] as const;
export const CANCEL_PENDING_INPUT_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'inputId',
  'sessionId',
  'reason',
] as const;
export const DISPATCH_PENDING_INPUT_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'inputId',
  'sessionId',
  'targetRunId',
] as const;
export const LIST_PENDING_INPUTS_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'sessionId',
] as const;
export const PENDING_INPUT_RECORD_FIELDS = [
  'id',
  'sessionId',
  'runId',
  'text',
  'mode',
  'status',
  'createdAt',
  'updatedAt',
  'source',
  'metadata',
] as const;
export const PENDING_INPUT_QUEUED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'input',
  'event',
] as const;
export const PENDING_INPUT_CANCELLED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'input',
  'event',
] as const;
export const PENDING_INPUT_DISPATCHED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'input',
  'event',
] as const;
export const PENDING_INPUTS_LISTED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'inputs',
  'sessionId',
] as const;
export const SESSION_ACTION_BASE_FIELDS = [
  'protocolVersion',
  'actionId',
  'kind',
  'sessionId',
  'requestedAt',
  'requestedBy',
  'idempotencyKey',
  'consistency',
] as const;
export const SESSION_ACTION_CONSISTENCY_FIELDS = [
  'expectedSessionVersion',
  'eventLogCursor',
  'workspaceVersionId',
  'parentActionId',
] as const;
export const SESSION_ACTION_RECEIPT_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'protocolVersion',
  'actionId',
  'kind',
  'sessionId',
  'status',
  'committedAt',
  'resultingSessionId',
  'resultingEventId',
  'resultingWorkspaceVersionId',
  'errorCode',
  'errorMessage',
] as const;

export const DAEMON_READY_FIELDS = [
  'type',
  'port',
  'protocolVersion',
  'buildHash',
] as const;
export const EVENT_FIELDS = [
  'type',
  'runId',
  'orchestratorEventId',
  'sequence',
  'timestamp',
  'event',
] as const;
export const APPROVAL_REQUESTED_FIELDS = [
  'type',
  'runId',
  'toolCallId',
  'toolName',
  'input',
  'summary',
  'timeoutMs',
  'expiresAt',
  'remainingMs',
  'risk',
  'riskReason',
  'requiresDoubleConfirm',
  'recommendSnapshot',
  'metadata',
] as const;
export const APPROVAL_RESOLVED_FIELDS = [
  'type',
  'toolCallId',
  'decision',
  'reason',
  'expiredAt',
] as const;
export const ERROR_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'code',
  'message',
  'runId',
] as const;
export const STATUS_RESPONSE_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'lifecycle',
  'activeRuns',
  'pendingApprovals',
  'recentApprovals',
  'providerStatus',
  'mcpStatus',
  'capabilities',
] as const;
export const CAPABILITIES_RESPONSE_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'snapshot',
] as const;
export const CAPABILITY_SNAPSHOT_FIELDS = [
  'schemaVersion',
  'generatedAt',
  'capabilities',
] as const;
export const CAPABILITY_RECORD_FIELDS = [
  'id',
  'title',
  'state',
  'reason',
  'owner',
  'relatedMessageTypes',
  'relatedTauriCommands',
  'updatedAt',
  'diagnostics',
] as const;
export const CAPABILITY_DIAGNOSTIC_FIELDS = [
  'code',
  'message',
  'severity',
  'updatedAt',
  'detail',
  'metadata',
] as const;
export const LIFECYCLE_FIELDS = [
  'state',
  'startedAt',
  'updatedAt',
  'readyAt',
  'stoppingAt',
  'stoppedAt',
  'uptimeMs',
  'currentPort',
  'connectedClientCount',
  'totalClientConnectionCount',
  'totalClientDisconnectCount',
  'activeRunCount',
  'recentDisconnect',
  'recentError',
  'recentErrors',
  'eventStore',
  'providerReadiness',
  'mcpReadiness',
] as const;
export const CLIENT_DISCONNECT_FIELDS = [
  'clientId',
  'code',
  'reason',
  'connectedAt',
  'disconnectedAt',
  'durationMs',
] as const;
export const EVENT_STORE_STATUS_FIELDS = ['status', 'path', 'failure'] as const;
export const LIFECYCLE_DIAGNOSTIC_FIELDS = [
  'code',
  'message',
  'updatedAt',
  'source',
  'severity',
  'detail',
  'metadata',
] as const;
export const ACTIVE_RUN_FIELDS = [
  'runId',
  'prompt',
  'status',
  'startedAt',
  'cwd',
] as const;
export const PENDING_APPROVAL_FIELDS = [
  'toolCallId',
  'runId',
  'toolName',
  'summary',
  'createdAt',
  'status',
  'timeoutMs',
  'expiresAt',
  'remainingMs',
  'resolvedAt',
  'expiredAt',
  'reason',
  'expiredReason',
  'risk',
  'riskReason',
  'requiresDoubleConfirm',
  'recommendSnapshot',
  'metadata',
] as const;
export const PROVIDER_STATUS_FIELDS = [
  'credentialMode',
  'readiness',
  'providerId',
  'routeId',
  'baseUrl',
  'model',
  'upstreamModel',
  'endpoint',
  'stream',
  'systemPromptWireMode',
  'apiKey',
  'hasDirectApiKey',
  'apiKeySource',
  'gateway',
  'lastDiagnostic',
  'updatedAt',
  'lastProbeOk',
  'lastProbeAt',
] as const;
export const PROVIDER_REDACTED_API_KEY_FIELDS = [
  'hasApiKey',
  'source',
  'last4',
] as const;
export const PROVIDER_GATEWAY_STATUS_FIELDS = [
  'ready',
  'credentialConfigured',
  'routeDecision',
  'code',
  'selectedRouteId',
  'selectedProviderId',
  'selectedEndpointSupport',
  'selectedStreamingSupport',
  'selectedCredentialSource',
  'lastSuccess',
  'lastFailure',
  'updatedAt',
] as const;
export const PROVIDER_DIAGNOSTIC_FIELDS = [
  'code',
  'message',
  'updatedAt',
  'kind',
  'status',
  'detail',
  'metadata',
] as const;
export const MCP_STATUS_FIELDS = [
  'configured',
  'readiness',
  'serverCount',
  'summary',
  'diagnostics',
  'servers',
  'updatedAt',
] as const;
export const CONFIG_UPDATED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'updatedFields',
] as const;
export const SUBAGENT_STARTED_FIELDS = [
  'type',
  'runId',
  'subagentId',
  'subagentRunId',
  'parentToolCallId',
  'description',
  'mode',
] as const;
export const SUBAGENT_ENDED_FIELDS = [
  'type',
  'runId',
  'subagentId',
  'subagentRunId',
  'parentToolCallId',
  'status',
  'summary',
] as const;
export const SUBAGENT_EVENT_FIELDS = [
  'type',
  'runId',
  'subagentId',
  'subagentRunId',
  'parentToolCallId',
  'event',
] as const;
export const SESSIONS_LISTED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'sessions',
  'summaries',
  'eventLog',
  'diagnostics',
] as const;
export const RUNS_LISTED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'runs',
  'sessionId',
] as const;
export const SESSION_EVENTS_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'sessionId',
  'events',
  'eventLog',
  'cursorDiagnostic',
  'diagnostics',
  'nextAfterSequence',
  'hasMore',
  'nextCursor',
  'afterSequence',
  'lastEventId',
] as const;
export const RUN_EVENTS_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'runId',
  'events',
  'eventLog',
  'cursorDiagnostic',
  'diagnostics',
  'nextAfterSequence',
  'hasMore',
  'nextCursor',
  'afterSequence',
  'lastEventId',
  'snapshot',
] as const;
export const RUN_SNAPSHOT_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'runId',
  'snapshot',
] as const;
export const WORKFLOWS_LISTED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'workflows',
] as const;
export const WORKFLOW_CREATED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'workflow',
] as const;
export const WORKFLOW_UPDATED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'workflow',
] as const;
export const WORKFLOW_DELETED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'workflowId',
] as const;
export const WORKFLOW_TRIGGERED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'accepted',
  'runId',
  'workflowRunId',
  'run',
] as const;
export const WORKFLOW_RUN_UPDATED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'runId',
  'workflowRunId',
  'workflowId',
  'run',
] as const;
export const WORKFLOW_RUNS_LISTED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'runs',
  'workflowId',
] as const;
export const GIT_STATUS_RESPONSE_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'cwd',
  'found',
  'repositoryRoot',
  'gitDir',
  'head',
  'branch',
  'clean',
  'files',
  'stagedCount',
  'unstagedCount',
  'untrackedCount',
  'conflictedCount',
  'reason',
] as const;
